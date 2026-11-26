package io.github.amirrezashafiei.simpleray;

import android.Manifest;
import android.app.Activity;
import android.app.StatusBarManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.net.VpnService;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import androidx.core.content.FileProvider;
import com.google.zxing.integration.android.IntentIntegrator;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final int VPN = 67, FILE = 68, OPEN_BACKUP = 70, SAVE_BACKUP = 71;
    private static final String BACKUP_MIME = "application/json";
    private static final int BACKUP_CAP = 25_000_000;
    private static final int CAP = 2_000_000;
    private final ExecutorService worker = Executors.newFixedThreadPool(3);
    private WebView web;
    private FrameLayout root;
    private SecureStore store;
    private JSONObject awaitingConsent;
    private String pendingShared, pendingBackup;
    private Uri backupDestination;
    private boolean backupDestinationAnnounced;
    private boolean ready, coldStart;
    private long lastTest = 0;

    @SuppressWarnings("SetJavaScriptEnabled")
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        coldStart = saved == null && !RayVpn.running();
        store = new SecureStore(this);
        root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        configureInsets();
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setSupportMultipleWindows(false);
        web.getSettings().setTextZoom(100);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !request.getUrl().toString().equals(ORIGIN + "/ui/index.html");
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String path = uri.getPath();
                if (!"https".equals(uri.getScheme()) || !"appassets.androidplatform.net".equals(uri.getHost())
                        || path == null || path.contains("..") || !(path.startsWith("/ui/") || path.startsWith("/shared/"))) {
                    return empty();
                }
                try {
                    String mime = path.endsWith(".js") ? "application/javascript" : path.endsWith(".css") ? "text/css"
                            : path.endsWith(".svg") ? "image/svg+xml" : "text/html";
                    return new WebResourceResponse(mime, "UTF-8", getAssets().open(path.substring(1)));
                } catch (Exception missing) { return empty(); }
            }

            @Override public void onPageFinished(WebView page, String url) {
                if (!url.equals(ORIGIN + "/ui/index.html")) return;
                ready = true;
                event("device", Core.object("dark", systemDark(), "startup", coldStart));
                coldStart = false;
                deliverPending();
            }
        });
        web.addJavascriptInterface(new Bridge(), "SimpleRayNative");
        if (saved != null) backupDestination = saved.getParcelable("backupDestination");
        takeShared(getIntent());
        web.loadUrl(ORIGIN + "/ui/index.html");
    }

    private static WebResourceResponse empty() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    @SuppressWarnings("deprecation")
    private void configureInsets() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            getWindow().setStatusBarColor(Color.TRANSPARENT);
            getWindow().setNavigationBarColor(Color.TRANSPARENT);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                var safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                var keyboard = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, Math.max(safe.bottom, keyboard.bottom));
                return insets;
            });
        }
        applyBars(systemDark(), "#F4F8FC");
    }

    @SuppressWarnings("deprecation")
    private void applyBars(boolean dark, String background) {
        int color;
        try { color = Color.parseColor(background); }
        catch (Exception unsupported) { color = dark ? 0xff101820 : 0xfff4f8fc; }
        root.setBackgroundColor(color);
        web.setBackgroundColor(color);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController control = getWindow().getInsetsController();
            int flags = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            if (control != null) control.setSystemBarsAppearance(dark ? 0 : flags, flags);
        } else {
            getWindow().setStatusBarColor(color);
            getWindow().setNavigationBarColor(color);
            getWindow().getDecorView().setSystemUiVisibility(dark ? 0 :
                    View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
    }

    private boolean systemDark() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }

    @Override protected void onResume() {
        super.onResume();
        if (ready) event("device", Core.object("dark", systemDark(), "startup", false));
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        takeShared(intent);
        deliverPending();
    }

    @SuppressWarnings("deprecation")
    private void takeShared(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        Uri document = Build.VERSION.SDK_INT >= 33 ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
                : intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (document == null && intent.getClipData() != null && intent.getClipData().getItemCount() > 0)
            document = intent.getClipData().getItemAt(0).getUri();
        if (document != null && "content".equals(document.getScheme())) {
            readDocument(document, true);
            setIntent(new Intent(this, MainActivity.class));
            return;
        }
        CharSequence value = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (value == null && intent.getClipData() != null && intent.getClipData().getItemCount() > 0) {
            value = intent.getClipData().getItemAt(0).getText();
        }
        if (value != null && value.length() <= CAP) pendingShared = value.toString();
        setIntent(new Intent(this, MainActivity.class));
    }

    private void deliverPending() {
        if (!ready) return;
        if (pendingShared != null) {
            event("import", pendingShared);
            pendingShared = null;
        }
        if (pendingBackup != null) {
            event("backup", pendingBackup);
            pendingBackup = null;
        }
        if (backupDestination != null && !backupDestinationAnnounced) {
            backupDestinationAnnounced = true;
            event("backupDestination", true);
        }
    }

    private void readDocument(Uri document, boolean backup) {
        worker.execute(() -> {
            String content;
            try (InputStream input = getContentResolver().openInputStream(document)) {
                if (input == null) throw new IllegalStateException();
                content = readBounded(input, backup ? BACKUP_CAP : CAP);
            } catch (Exception failure) {
                if (!backup) {
                    event("notice", "Could not read the selected configuration file.");
                    return;
                }
                content = "";
            }
            String value = content;
            runOnUiThread(() -> {
                if (backup) pendingBackup = value;
                else pendingShared = value;
                deliverPending();
            });
        });
    }

    @Override protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putParcelable("backupDestination", backupDestination);
    }

    @Override @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (!ready) { super.onBackPressed(); return; }
        web.evaluateJavascript("window.rayBack && window.rayBack()", value -> {
            if (!"true".equals(value)) moveTaskToBack(true);
        });
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == VPN) {
            JSONObject plan = awaitingConsent;
            awaitingConsent = null;
            if (resultCode == RESULT_OK && plan != null) launchVpn(plan);
            else event("notice", "VPN permission was not granted.");
        } else if (requestCode == FILE || requestCode == OPEN_BACKUP || requestCode == SAVE_BACKUP) {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
            if (requestCode == SAVE_BACKUP) {
                backupDestination = data.getData();
                backupDestinationAnnounced = false;
                deliverPending();
            } else readDocument(data.getData(), requestCode == OPEN_BACKUP);
        } else {
            var scan = IntentIntegrator.parseActivityResult(requestCode, resultCode, data);
            if (scan != null && scan.getContents() != null) event("import", scan.getContents());
        }
    }

    @Override protected void onDestroy() {
        worker.shutdownNow();
        if (web != null) {
            root.removeView(web);
            web.removeJavascriptInterface("SimpleRayNative");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    private void connect(JSONObject plan) {
        if (plan.optJSONObject("profile") == null) { event("notice", "Choose a server first."); return; }
        Intent permission = VpnService.prepare(this);
        if (permission == null) launchVpn(plan);
        else if (awaitingConsent == null) {
            awaitingConsent = plan;
            startActivityForResult(permission, VPN);
        }
    }

    private void launchVpn(JSONObject plan) {
        try {
            RayVpn.start(this, plan);
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED && !getPreferences(MODE_PRIVATE).getBoolean("asked", false)) {
                getPreferences(MODE_PRIVATE).edit().putBoolean("asked", true).apply();
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 69);
            }
        } catch (Exception unavailable) { event("notice", "Android could not start the VPN."); }
    }

    private void tile() {
        if (Build.VERSION.SDK_INT >= 33) {
            getSystemService(StatusBarManager.class).requestAddTileService(new ComponentName(this, RayTile.class),
                    "SimpleRAY", Icon.createWithResource(this, R.drawable.ray_symbol), getMainExecutor(), result -> {});
        } else event("notice", "Edit the Android Quick Settings panel and drag in the SimpleRAY tile.");
    }

    private JSONArray apps() {
        var launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        var packageManager = getPackageManager();
        var labels = new java.util.HashMap<String, String>();
        for (ResolveInfo app : packageManager.queryIntentActivities(launcher, 0)) {
            String id = app.activityInfo.packageName;
            if (!id.equals(getPackageName()))
                labels.computeIfAbsent(id, ignored -> app.loadLabel(packageManager).toString());
        }
        var entries = new ArrayList<>(labels.entrySet());
        entries.sort(java.util.Map.Entry.comparingByValue(String.CASE_INSENSITIVE_ORDER));
        JSONArray result = new JSONArray();
        for (var entry : entries) result.put(Core.object("id", entry.getKey(), "label", entry.getValue()));
        return result;
    }

    private static String readBounded(InputStream input, int limit) throws Exception {
        byte[] buffer = new byte[8192];
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        for (int n; (n = input.read(buffer)) != -1;) {
            if (output.size() + n > limit) throw new IllegalArgumentException("File is too large");
            output.write(buffer, 0, n);
        }
        return output.toString(StandardCharsets.UTF_8.name()).replaceFirst("^\ufeff", "");
    }

    private static String fetch(String input) throws Exception {
        URL url = new URL(input);
        for (int i = 0; i < 5; i++) {
            URI uri = url.toURI();
            if (!(uri.getScheme().equalsIgnoreCase("http") || uri.getScheme().equalsIgnoreCase("https"))
                    || uri.getHost() == null || uri.getUserInfo() != null) throw new IllegalArgumentException("Invalid subscription URL");
            HttpURLConnection connection = (HttpURLConnection) url.openConnection(java.net.Proxy.NO_PROXY);
            try {
                connection.setConnectTimeout(12_000);
                connection.setReadTimeout(12_000);
                connection.setInstanceFollowRedirects(false);
                connection.setRequestProperty("User-Agent", "SimpleRAY-Android/0.2");
                int code = connection.getResponseCode();
                if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                    String location = connection.getHeaderField("Location");
                    if (location == null) throw new IllegalStateException("Subscription redirect failed");
                    URL next = new URL(url, location);
                    if ("https".equals(url.getProtocol()) && !"https".equals(next.getProtocol()))
                        throw new IllegalStateException("The subscription redirected to an insecure URL");
                    url = next;
                } else {
                    if (code < 200 || code >= 300) throw new IllegalStateException("Subscription returned HTTP " + code);
                    try (InputStream stream = connection.getInputStream()) { return readBounded(stream, CAP); }
                }
            } finally { connection.disconnect(); }
        }
        throw new IllegalStateException("Subscription redirect limit reached");
    }

    private static String backupName() {
        return "SimpleRAY-Backup-" + LocalDateTime.now().format(
                DateTimeFormatter.ofPattern("yyyy-MM-dd_HH-mm-ss", Locale.ROOT)) + ".json";
    }

    private static byte[] backupBytes(String text) {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length == 0 || bytes.length > BACKUP_CAP) throw new IllegalArgumentException("Backup is too large");
        return bytes;
    }

    private void writeBackup(String id, Uri destination, String text) {
        try {
            byte[] bytes = backupBytes(text);
            try (OutputStream stream = getContentResolver().openOutputStream(destination, "wt")) {
                if (stream == null) throw new IllegalStateException();
                stream.write(bytes);
            }
            response(id, true);
        } catch (Exception failure) { error(id, "Could not save this backup file."); }
    }

    private void shareBackup(String id, String text) {
        try {
            File directory = new File(getCacheDir(), "portable-backups");
            Files.createDirectories(directory.toPath());
            File[] old = directory.listFiles();
            long previousDay = System.currentTimeMillis() - 86_400_000;
            if (old != null) for (File file : old) {
                if (file.lastModified() < previousDay) file.delete();
            }
            File file = new File(directory, backupName());
            Files.write(file.toPath(), backupBytes(text));
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".backups", file);
            Intent share = new Intent(Intent.ACTION_SEND).setType(BACKUP_MIME).putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            share.setClipData(ClipData.newUri(getContentResolver(), "SimpleRAY backup", uri));
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                startActivity(Intent.createChooser(share, "Share SimpleRAY backup"));
                response(id, true);
            });
        } catch (Exception failure) { error(id, "Could not share this backup file."); }
    }

    private void event(String type, Object value) {
        runOnUiThread(() -> {
            if (web == null || !ready) return;
            String payload = Core.object("type", type, "value", value).toString();
            web.evaluateJavascript("window.receiveNative && window.receiveNative(" + JSONObject.quote(payload) + ")", null);
        });
    }

    private void response(String id, Object value) { event("response", Core.object("id", id, "result", value)); }

    private void error(String id, String message) { event("response", Core.object("id", id, "error", message)); }

    public final class Bridge {
        @JavascriptInterface public String status() { return RayVpn.status().toString(); }

        @JavascriptInterface public String get(String key) {
            try { return store.read(key); }
            catch (Exception error) { return "#unreadable"; }
        }

        @JavascriptInterface public boolean set(String key, String value) {
            try { store.write(key, value); return true; }
            catch (Exception error) { return false; }
        }

        @JavascriptInterface public void request(String id, String action, String input) {
            try {
                JSONObject data = new JSONObject(input);
                switch (action) {
                    case "connect" -> runOnUiThread(() -> connect(data));
                    case "disconnect" -> runOnUiThread(() -> RayVpn.stop(MainActivity.this));
                    case "switch" -> runOnUiThread(() -> RayVpn.accept(MainActivity.this));
                    case "undo" -> runOnUiThread(() -> RayVpn.undo(MainActivity.this));
                    case "live" -> RayVpn.refreshLatency();
                    case "policy" -> RayVpn.setPolicy(data);
                    case "tile" -> runOnUiThread(MainActivity.this::tile);
                    case "bars" -> runOnUiThread(() -> applyBars(data.optBoolean("dark"), data.optString("color")));
                    case "notificationSettings" -> runOnUiThread(() -> startActivity(
                            new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())));
                    case "vpnSettings" -> runOnUiThread(() -> startActivity(new Intent(Settings.ACTION_VPN_SETTINGS)));
                    case "scan" -> runOnUiThread(() -> new IntentIntegrator(MainActivity.this)
                            .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE).setOrientationLocked(false)
                            .setPrompt("Scan a server or subscription QR code").initiateScan());
                    case "openBackup" -> runOnUiThread(() -> startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT)
                            .addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"), OPEN_BACKUP));
                    case "saveBackup" -> runOnUiThread(() -> startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT)
                            .addCategory(Intent.CATEGORY_OPENABLE).setType(BACKUP_MIME)
                            .putExtra(Intent.EXTRA_TITLE, backupName()), SAVE_BACKUP));
                    case "writeBackup" -> runOnUiThread(() -> {
                        Uri destination = backupDestination;
                        backupDestination = null;
                        if (destination == null) error(id, "Select a file to save the backup.");
                        else worker.execute(() -> writeBackup(id, destination, data.optString("text")));
                    });
                    case "shareBackup" -> worker.execute(() -> shareBackup(id, data.optString("text")));
                    case "file" -> runOnUiThread(() -> startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT)
                            .addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"), FILE));
                    case "clipboard" -> runOnUiThread(() -> {
                        ClipboardManager clipboard = getSystemService(ClipboardManager.class);
                        ClipData clip = clipboard.getPrimaryClip();
                        CharSequence value = clip == null || clip.getItemCount() == 0 ? null
                                : clip.getItemAt(0).coerceToText(MainActivity.this);
                        response(id, value == null || value.length() > CAP ? "" : value.toString());
                    });
                    case "copy" -> runOnUiThread(() -> {
                        var clip = ClipData.newPlainText("SimpleRAY", data.optString("text"));
                        if (Build.VERSION.SDK_INT >= 33 && data.optBoolean("sensitive")) {
                            var extras = new android.os.PersistableBundle();
                            extras.putBoolean( android.content.ClipDescription.EXTRA_IS_SENSITIVE, true);
                            clip.getDescription().setExtras(extras);
                        }
                        getSystemService(ClipboardManager.class).setPrimaryClip(clip);
                    });
                    case "share" -> runOnUiThread(() -> startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND)
                            .setType("text/plain").putExtra(Intent.EXTRA_TEXT, data.optString("text")), "Share config")));
                    case "fetch", "ping", "apps", "download" -> worker.execute(() -> background(id, action, data));
                    default -> error(id, "Unknown action");
                }
            } catch (Exception invalid) { error(id, "Could not complete the action"); }
        }

        private void background(String id, String action, JSONObject data) {
            try {
                switch (action) {
                    case "fetch" -> response(id, fetch(data.getString("url")));
                    case "ping" -> response(id, ProbeService.ping(MainActivity.this, data.getJSONArray("profiles"),
                            data.getInt("timeout")));
                    case "apps" -> response(id, apps());
                    case "download" -> {
                        synchronized (this) {
                            long now = android.os.SystemClock.elapsedRealtime();
                            if (lastTest != 0 && now - lastTest < 2000) throw new IllegalStateException("Test already requested");
                            lastTest = now;
                        }
                        Core.Reply result = RayVpn.downloadTest();
                        response(id, Core.object("bytes", result.bytes(), "ms", result.elapsed()));
                    }
                    default -> error(id, "Unknown action");
                }
            } catch (Exception failure) {
                String safe = switch (action) {
                    case "fetch" -> "Could not download this subscription";
                    case "ping" -> "Could not complete the ping test";
                    case "download" -> "Test did not complete through the active connection";
                    default -> "Could not complete the action";
                };
                error(id, safe);
            }
        }
    }
}
