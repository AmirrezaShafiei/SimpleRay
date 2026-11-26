package io.github.amirrezashafiei.simpleray;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.service.quicksettings.TileService;
import go.Seq;
import hev.htproxy.TProxyService;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import libXray.LibXray;
import org.json.JSONArray;
import org.json.JSONObject;

public final class RayVpn extends VpnService {
    private static final String START = "sr.start", STOP = "sr.stop", SWITCH = "sr.switch", UNDO = "sr.undo";
    static final String CHANNEL = "ray-vpn";
    private static final int NOTICE = 181;
    private static final long NOTICE_INTERVAL_MS = 2000, HEALTH_INTERVAL_MS = 10_000;
    private static volatile JSONObject status = Core.object("phase", "disconnected");
    private static volatile RayVpn active;
    private static boolean socketProtectionRegistered;
    private final ScheduledThreadPoolExecutor worker = new ScheduledThreadPoolExecutor(1);
    private final ExecutorService healthChecks = Executors.newSingleThreadExecutor();
    private final ExecutorService candidateChecks = Executors.newSingleThreadExecutor();
    private volatile long generation;
    private volatile Session session;
    private JSONObject plan, profile, suggestion, undo;
    private Network upstream;
    private ParcelFileDescriptor tun;
    private File configFile;
    private ConnectivityManager connectivity;
    private NotificationManager notifications;
    private SecureStore store;
    private String phase = "disconnected";
    private boolean core, bridge, healthRefresh, candidatesPending;
    private Session pendingHealth;
    private String lastNoticeMetrics = "";
    private long lastNoticeUpdate;
    private long latency = -1, upload, download, savedUpload, savedDownload;
    private long rateUp, rateDown, lastStats, prevUpload, prevDownload, nextHealth, nextCandidates, nextRetry, undoUntil, cooldownUntil;
    private int failures, wins, samples, retryIndex, betterRounds;
    private String betterId;

    private record Session(String profileId, int probePort, String user, String secret) {}
    private record Candidate(JSONObject profile, long delay) {}

    static JSONObject status() { return status; }
    static boolean running() { return status.optBoolean("running"); }
    static void start(Context context, JSONObject plan) {
        Intent intent = new Intent(context, RayVpn.class).setAction(START);
        if (plan != null) intent.putExtra("plan", plan.toString());
        context.startForegroundService(intent);
    }
    static void stop(Context context) { action(context, STOP); }
    static void accept(Context context) { action(context, SWITCH); }
    static void undo(Context context) { action(context, UNDO); }
    private static void action(Context context, String action) {
        if (active == null) return;
        context.startService(new Intent(context, RayVpn.class).setAction(action));
    }

    static void setPolicy(JSONObject plan) {
        RayVpn current = active;
        if (current == null) return;
        current.worker.execute(() -> {
            if (current.plan == null || current.profile == null) return;
            try {
                String mode = plan.optString("switching", "off");
                if (!mode.equals(current.plan.optString("switching", "off")) || !String.valueOf(plan.optJSONArray("candidates"))
                        .equals(String.valueOf(current.plan.optJSONArray("candidates")))) {
                    current.suggestion = null;
                    current.betterId = null;
                    current.betterRounds = 0;
                    current.nextCandidates = 0;
                    current.plan.put("switching", mode);
                    current.plan.put("candidates", plan.optJSONArray("candidates"));
                }
            } catch (Exception ignored) { }
        });
    }

    static Core.Reply downloadTest() throws Exception {
        RayVpn service = active;
        Session current = service == null ? null : service.session;
        if (current == null || !"connected".equals(status.optString("phase")))
            throw new IllegalStateException("Connect before running a download test");
        Core.Reply result = Core.fetchThrough(current.probePort(), current.user(), current.secret(),
                "https://speed.cloudflare.com/__down?bytes=3000000", 3_000_000, false, 7000);
        if (service.session != current) throw new IllegalStateException("The connection changed during the test");
        if (result.status() != 200 || result.bytes() < 1_000)
            throw new IllegalStateException("The download test did not complete");
        return result;
    }

    static void refreshLatency() {
        RayVpn service = active;
        if (service != null) service.worker.execute(() -> service.healthRefresh = true);
    }

    @Override public void onCreate() {
        super.onCreate();
        Seq.setContext(this);
        active = this;
        if (!socketProtectionRegistered) {
            LibXray.registerDialerController(fd -> {
                RayVpn current = active;
                return current == null || current.protect((int) fd);
            });
            socketProtectionRegistered = true;
        }
        connectivity = getSystemService(ConnectivityManager.class);
        store = new SecureStore(this);
        configFile = new File(getCacheDir(), "ray-bridge.yml");
        NotificationChannel channel = new NotificationChannel(CHANNEL, "VPN connection", NotificationManager.IMPORTANCE_LOW);
        channel.setShowBadge(false);
        channel.setSound(null, null);
        notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(channel);
        worker.setRemoveOnCancelPolicy(true);
        worker.scheduleWithFixedDelay(this::monitor, 1, 1, TimeUnit.SECONDS);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (STOP.equals(action)) {
            long token = ++generation;
            status = Core.object("phase", "stopping", "running", true, "profileId", status.optString("profileId"));
            worker.execute(() -> stopSession(token, startId));
            return START_NOT_STICKY;
        }
        if (SWITCH.equals(action) || UNDO.equals(action)) {
            worker.execute(() -> {
                JSONObject choice = SWITCH.equals(action) ? suggestion
                        : (SystemClock.elapsedRealtime() < undoUntil ? undo : null);
                if (choice != null) switchTo(choice, false);
            });
            return START_STICKY;
        }
        long token = ++generation;
        status = Core.object("phase", "connecting", "running", true,
                "profileId", status.optString("profileId"), "name", status.optString("name"));
        startForeground(NOTICE, notification(status, ""));
        String supplied = intent == null ? null : intent.getStringExtra("plan");
        worker.execute(() -> {
            if (token != generation) return;
            try {
                if (prepare(this) != null) throw new IllegalStateException("VPN permission required");
                String raw = supplied == null ? store.read("launch") : supplied;
                if (raw.isBlank()) throw new IllegalStateException("Choose a server before connecting");
                startSession(new JSONObject(raw), token);
            } catch (Exception failure) {
                if (token == generation) {
                    closeTunnel();
                    publish("failed", false);
                    stopSelf(startId);
                }
            }
        });
        return START_STICKY;
    }

    @Override public void onRevoke() {
        long token = ++generation;
        worker.execute(() -> stopSession(token, 0));
    }

    @Override public void onDestroy() {
        ++generation;
        active = null;
        healthChecks.shutdownNow();
        candidateChecks.shutdownNow();
        worker.execute(() -> {
            closeTunnel();
            profile = null;
            if (!"failed".equals(status.optString("phase"))) publish("disconnected", false);
        });
        worker.shutdown();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    private void startSession(JSONObject next, long token) throws Exception {
        JSONObject nextRouting = next.optJSONObject("routing");
        JSONObject previousRouting = plan == null ? null : plan.optJSONObject("routing");
        if (tun != null && !String.valueOf(nextRouting).equals(String.valueOf(previousRouting))) {
            Network network = physicalNetwork();
            if (network != null) {
                ParcelFileDescriptor replacement = openTunnel(network, nextRouting);
                closeTunnel();
                tun = replacement;
            } else closeTunnel();
        } else stopEngine();
        plan = next;
        profile = next.getJSONObject("profile");
        store.write("launch", next.toString());
        upload = download = savedUpload = savedDownload = prevUpload = prevDownload = rateDown = rateUp = 0;
        lastStats = 0;
        undo = suggestion = null;
        failures = wins = samples = retryIndex = betterRounds = 0;
        latency = -1;
        nextRetry = nextCandidates = nextHealth = 0;
        if (token == generation) establish(token, false);
    }

    private void establish(long token, boolean retry) throws Exception {
        if (token != generation || profile == null) return;
        Network network = physicalNetwork();
        if (network == null) {
            publish("waiting", true);
            return;
        }
        publish(retry ? "reconnecting" : "connecting", true);
        stopEngine();
        if (tun == null) tun = openTunnel(network, plan.optJSONObject("routing"));
        else setUnderlyingNetworks(new Network[]{network});
        upstream = network;
        if (token != generation) return;
        String user = UUID.randomUUID().toString();
        String secret = UUID.randomUUID().toString();
        int relay = Core.freePort();
        int probe;
        do { probe = Core.freePort(); } while (probe == relay);
        JSONObject config = Core.config(profile, plan.optJSONObject("routing"), relay, probe, user, secret);
        Core.call("runXray", Core.object("xrayJson", config.toString()));
        core = true;
        String bridgeConfig = "tunnel:\n  mtu: 1500\n  ipv4: 172.29.8.1\n  ipv6: 'fd6f:2042:8::1'\n"
                + "socks5:\n  address: 127.0.0.1\n  port: " + relay
                + "\n  udp: 'udp'\n  username: '" + user + "'\n  password: '" + secret
                + "'\nmisc:\n  log-level: error\n";
        Files.write(configFile.toPath(), bridgeConfig.getBytes(StandardCharsets.UTF_8));
        if (!TProxyService.TProxyStartService(configFile.getAbsolutePath(), tun.getFd()))
            throw new IllegalStateException("Could not start packet bridge");
        bridge = true;
        session = new Session(profile.getString("id"), probe, user, secret);
        latency = Core.health(probe, user, secret);
        if (token != generation) return;
        if (latency >= 0 && TProxyService.TProxyIsRunning()) {
            wins = 1;
            samples = 1;
            failures = retryIndex = 0;
            nextHealth = SystemClock.elapsedRealtime() + HEALTH_INTERVAL_MS;
            publish("connected", true);
            Session established = session;
            new Thread(() -> saveExitIp(established), "ray-exit-ip").start();
        } else {
            failures++;
            nextRetry = SystemClock.elapsedRealtime() + Math.min(30_000, 5000L * ++retryIndex);
            publish("problem", true);
        }
    }

    private ParcelFileDescriptor openTunnel(Network network, JSONObject routing) throws Exception {
        Builder builder = new Builder().setSession("SimpleRAY").setMtu(1500)
                .addAddress("172.29.8.1", 32).addAddress("fd6f:2042:8::1", 128)
                .addRoute("0.0.0.0", 0).addRoute("::", 0)
                .addDnsServer("1.1.1.1").addDnsServer("2606:4700:4700::1111")
                .setUnderlyingNetworks(new Network[]{network});
        String mode = routing == null ? "all" : routing.optString("appMode", "all");
        JSONArray apps = routing == null ? null : routing.optJSONArray("apps");
        if ("only".equals(mode)) {
            int included = 0;
            for (int i = 0; apps != null && i < apps.length(); i++) {
                String app = apps.getString(i);
                if (app.equals(getPackageName())) continue;
                try { builder.addAllowedApplication(app); included++; }
                catch (android.content.pm.PackageManager.NameNotFoundException missing) { }
            }
            if (included == 0) throw new IllegalArgumentException("Select an installed app");
        } else {
            builder.addDisallowedApplication(getPackageName());
            if ("except".equals(mode)) for (int i = 0; apps != null && i < apps.length(); i++) {
                String app = apps.getString(i);
                if (app.equals(getPackageName())) continue;
                try { builder.addDisallowedApplication(app); }
                catch (android.content.pm.PackageManager.NameNotFoundException missing) { }
            }
        }
        ParcelFileDescriptor descriptor = builder.establish();
        if (descriptor == null) throw new IllegalStateException("VPN permission required");
        return descriptor;
    }

    private void monitor() {
        long token = generation;
        if (profile == null) return;
        try {
            long now = SystemClock.elapsedRealtime();
            Network current = physicalNetwork();
            if (current == null) {
                if (!"waiting".equals(phase)) {
                    stopEngine();
                    upstream = null;
                    publish("waiting", true);
                }
                return;
            }
            if (!current.equals(upstream) || "waiting".equals(phase)) {
                establish(token, true);
                return;
            }
            if (undo != null && now >= undoUntil) {
                undo = null;
                publish(phase, true);
            }
            readTraffic(now);
            if ("connected".equals(phase) && pendingHealth == null && (healthRefresh || now >= nextHealth))
                checkHealth(token);
            if (("connected".equals(phase) || "problem".equals(phase)) && !candidatesPending
                    && now >= nextCandidates && !"off".equals(plan.optString("switching", "off"))) {
                nextCandidates = now + 30_000;
                checkCandidates(token);
            }
            if ("problem".equals(phase) && !candidatesPending && now >= nextRetry) {
                establish(token, true);
                return;
            }
            if (token == generation) publish(phase, true);
        } catch (Exception failure) {
            if (token == generation && profile != null) {
                stopEngine();
                nextRetry = SystemClock.elapsedRealtime() + Math.min(30_000, 5000L * ++retryIndex);
                publish("problem", true);
            }
        }
    }

    private Network physicalNetwork() {
        Network network = connectivity.getActiveNetwork();
        if (isPhysical(network)) return network;
        if (isPhysical(upstream)) return upstream;
        for (Network candidate : connectivity.getAllNetworks()) if (isPhysical(candidate)) return candidate;
        return null;
    }

    private boolean isPhysical(Network network) {
        if (network == null) return false;
        NetworkCapabilities cap = connectivity.getNetworkCapabilities(network);
        return cap != null && cap.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && !cap.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
    }

    private void afterProbe(Runnable result) {
        getMainExecutor().execute(() -> {
            if (active == this) worker.execute(result);
        });
    }

    private void checkHealth(long token) {
        Session probe = session;
        if (probe == null) return;
        healthRefresh = false;
        pendingHealth = probe;
        healthChecks.execute(() -> {
            long measured = Core.health(probe.probePort(), probe.user(), probe.secret());
            afterProbe(() -> {
                if (pendingHealth != probe) return;
                pendingHealth = null;
                if (token != generation || session != probe || !"connected".equals(phase)) return;
                latency = measured;
                samples++;
                if (latency < 0 || !TProxyService.TProxyIsRunning()) failures++;
                else { wins++; failures = 0; }
                long now = SystemClock.elapsedRealtime();
                nextHealth = now + HEALTH_INTERVAL_MS;
                if (failures >= 2) {
                    nextRetry = now + 1500;
                    publish("problem", true);
                } else publish(phase, true);
            });
        });
    }

    private void checkCandidates(long token) throws Exception {
        JSONArray candidates = plan.optJSONArray("candidates");
        if (candidates == null) return;
        List<JSONObject> eligible = new ArrayList<>();
        for (int i = 0; i < Math.min(candidates.length(), 6); i++) {
            JSONObject item = candidates.getJSONObject(i);
            if (!item.optString("id").equals(profile.optString("id"))) eligible.add(item);
        }
        if (eligible.isEmpty()) return;
        Session testedSession = session;
        String mode = plan.optString("switching");
        candidatesPending = true;
        candidateChecks.execute(() -> {
            Candidate best = findCandidate(eligible);
            afterProbe(() -> {
                candidatesPending = false;
                if (token != generation || session != testedSession || plan == null
                        || !mode.equals(plan.optString("switching")) || candidates != plan.optJSONArray("candidates")) return;
                if ("connected".equals(phase) || "problem".equals(phase)) applyCandidate(best, mode);
            });
        });
    }

    private Candidate findCandidate(List<JSONObject> eligible) {
        Candidate best = null;
        for (int i = 0; i < eligible.size(); i += ProbeService.MAX_BATCH) {
            List<JSONObject> batch = eligible.subList(i, Math.min(i + ProbeService.MAX_BATCH, eligible.size()));
            try {
                JSONArray results = ProbeService.ping(this, new JSONArray(batch), 5);
                for (int j = 0; j < results.length() && j < batch.size(); j++) {
                    JSONObject measured = results.getJSONObject(j);
                    long delay = measured.optLong("delay", -1);
                    if (measured.optBoolean("success") && delay >= 0 && (best == null || delay < best.delay()))
                        best = new Candidate(batch.get(j), delay);
                }
            } catch (InterruptedException stopped) {
                Thread.currentThread().interrupt();
                return null;
            } catch (Exception unavailable) { }
        }
        return best;
    }

    private void applyCandidate(Candidate best, String mode) {
        boolean outage = "problem".equals(phase);
        if (best == null || (!outage && (latency < 0 || latency - best.delay() < 150 || best.delay() > latency * .60))) {
            suggestion = null;
            betterId = null;
            betterRounds = 0;
            publish(phase, true);
            return;
        }
        String id = best.profile().optString("id");
        betterRounds = id.equals(betterId) ? betterRounds + 1 : 1;
        betterId = id;
        if (!outage && (betterRounds < 2 || SystemClock.elapsedRealtime() < cooldownUntil)) return;
        if ("automatic".equals(mode)) switchTo(best.profile(), true);
        else {
            suggestion = best.profile();
            publish(phase, true);
        }
    }

    private void switchTo(JSONObject choice, boolean auto) {
        long token = generation;
        JSONObject previous = profile;
        if (previous == null || choice.optString("id").equals(previous.optString("id"))) return;
        try {
            profile = choice;
            plan.put("profile", choice);
            suggestion = null;
            betterRounds = failures = retryIndex = samples = wins = 0;
            establish(token, true);
            if (token != generation) return;
            if (!"connected".equals(phase)) {
                profile = previous;
                plan.put("profile", previous);
                establish(token, true);
                return;
            }
            store.write("launch", plan.toString());
            cooldownUntil = SystemClock.elapsedRealtime() + 90_000;
            undo = auto ? previous : null;
            undoUntil = SystemClock.elapsedRealtime() + 20_000;
            publish(phase, true);
        } catch (Exception failure) {
            profile = previous;
            if (token != generation) return;
            try { plan.put("profile", previous); establish(token, true); }
            catch (Exception unavailable) { publish("problem", true); }
        }
    }

    private void saveExitIp(Session snapshot) {
        try {
            Core.Reply reply = Core.fetchThrough(snapshot.probePort(), snapshot.user(), snapshot.secret(),
                    "https://api64.ipify.org/", 128, true, 4000);
            String ip = new String(reply.body(), StandardCharsets.US_ASCII).trim();
            if (reply.status() != 200 || !ip.matches("[A-Fa-f0-9:.]{3,45}")) return;
            worker.execute(() -> {
                if (session != snapshot) return;
                try {
                    String saved = store.read("history");
                    JSONArray old = saved.isBlank() ? new JSONArray() : new JSONArray(saved);
                    if (old.length() != 0) {
                        JSONObject latest = old.getJSONObject(0);
                        if (ip.equals(latest.optString("ip")) && snapshot.profileId().equals(latest.optString("id"))) return;
                    }
                    JSONArray next = new JSONArray().put(Core.object("id", snapshot.profileId(), "ip", ip,
                            "time", System.currentTimeMillis()));
                    for (int i = 0; i < Math.min(199, old.length()); i++) next.put(old.getJSONObject(i));
                    store.write("history", next.toString());
                } catch (Exception ignored) { }
            });
        } catch (Exception unavailable) { }
    }

    private void readTraffic(long now) {
        if (!bridge) return;
        long[] counters = TProxyService.TProxyGetStats();
        if (counters == null || counters.length < 4) return;
        upload = savedUpload + counters[1];
        download = savedDownload + counters[3];
        if (lastStats > 0) {
            long elapsed = Math.max(1, now - lastStats);
            rateUp = Math.max(0, upload - prevUpload) * 1000 / elapsed;
            rateDown = Math.max(0, download - prevDownload) * 1000 / elapsed;
        }
        lastStats = now;
        prevUpload = upload;
        prevDownload = download;
    }

    private void stopEngine() {
        pendingHealth = null;
        session = null;
        if (bridge) {
            readTraffic(SystemClock.elapsedRealtime());
            savedUpload = upload;
            savedDownload = download;
            TProxyService.TProxyStopService();
            bridge = false;
        }
        if (core) {
            try { Core.call("stopXray", new JSONObject()); } catch (Exception ignored) { }
            core = false;
        }
        configFile.delete();
        rateUp = rateDown = 0;
        lastStats = 0;
    }

    private void closeTunnel() {
        stopEngine();
        if (tun != null) {
            try { tun.close(); } catch (Exception ignored) { }
            tun = null;
        }
        upstream = null;
    }

    private void stopSession(long token, int startId) {
        if (token != generation) return;
        closeTunnel();
        profile = null;
        plan = null;
        undo = suggestion = null;
        publish("disconnected", false);
        if (startId == 0) stopSelf();
        else stopSelf(startId);
    }

    private void publish(String phase, boolean foreground) {
        this.phase = phase;
        JSONObject last = status;
        JSONObject next = Core.object("phase", phase, "running", foreground, "live", latency,
                "wins", wins, "samples", samples, "up", upload, "down", download, "rateUp", rateUp,
                "rateDown", rateDown, "profileId", profile == null ? "" : profile.optString("id"),
                "name", profile == null ? "" : profile.optString("name"),
                "suggestion", suggestion == null ? null : Core.object("id", suggestion.optString("id"),
                        "name", suggestion.optString("name")), "undo", undo != null);
        status = next;
        boolean changed = !last.optString("phase").equals(phase)
                || !last.optString("profileId").equals(next.optString("profileId"))
                || !last.optString("suggestion").equals(next.optString("suggestion"))
                || last.optBoolean("undo") != next.optBoolean("undo");
        long now = SystemClock.elapsedRealtime();
        String metrics = noticeMetrics(next);
        if (foreground && (changed || (now - lastNoticeUpdate >= NOTICE_INTERVAL_MS && !metrics.equals(lastNoticeMetrics)))) {
            notifications.notify(NOTICE, notification(next, metrics));
            lastNoticeMetrics = metrics;
            lastNoticeUpdate = now;
        }
        if (changed) TileService.requestListeningState(this, new ComponentName(this, RayTile.class));
    }

    static String label(String phase) {
        return switch (phase) {
            case "connected" -> "Connected";
            case "connecting" -> "Connecting…";
            case "reconnecting" -> "Reconnecting…";
            case "waiting" -> "Waiting for internet";
            case "problem" -> "Server unavailable";
            case "stopping" -> "Disconnecting…";
            case "failed" -> "Could not start VPN";
            default -> "Disconnected";
        };
    }

    private PendingIntent command(String action, int code) {
        return PendingIntent.getService(this, code, new Intent(this, RayVpn.class).setAction(action),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static String noticeMetrics(JSONObject detail) {
        if (!"connected".equals(detail.optString("phase"))) return "";
        long rate = detail.optLong("rateDown");
        String speed;
        if (rate >= 1024 * 1024) speed = String.format(Locale.ROOT, "%.1f MB/s", rate / (1024d * 1024));
        else if (rate >= 1024) speed = String.format(Locale.ROOT, "%.1f KB/s", rate / 1024d);
        else speed = rate + " B/s";
        long live = detail.optLong("live", -1);
        return "↓ " + speed + "  ·  " + (live >= 0 ? live + " ms" : "Latency —");
    }

    private Notification notification(JSONObject detail, String metrics) {
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        JSONObject choice = detail.optJSONObject("suggestion");
        String name = detail.optString("name");
        String suggestion = choice == null ? "" : "Try " + choice.optString("name");
        String text = metrics.isEmpty() ? (suggestion.isEmpty() ? name : suggestion) : metrics;
        Notification.Builder builder = new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ray_symbol)
                .setContentTitle(label(detail.optString("phase"))).setContentText(text)
                .setOnlyAlertOnce(true).setOngoing(true).setShowWhen(false)
                .setVisibility(Notification.VISIBILITY_PRIVATE).setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, "Disconnect", command(STOP, 1)).build());
        if (!metrics.isEmpty())
            builder.setStyle(new Notification.BigTextStyle().bigText(metrics
                    + (name.isBlank() ? "" : "\n" + name) + (suggestion.isBlank() ? "" : "\n" + suggestion)));
        if (Build.VERSION.SDK_INT >= 31) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        if (choice != null) builder.addAction(new Notification.Action.Builder(null, "Switch", command(SWITCH, 2)).build());
        else if (detail.optBoolean("undo")) builder.addAction(new Notification.Action.Builder(null, "Undo", command(UNDO, 3)).build());
        else if ("problem".equals(detail.optString("phase")))
            builder.addAction(new Notification.Action.Builder(null, "Choose server", open).build());
        return builder.build();
    }
}
