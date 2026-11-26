package io.github.amirrezashafiei.simpleray;

import android.app.Service;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import go.Seq;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

public final class ProbeService extends Service {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Messenger messenger = new Messenger(new Handler(Looper.getMainLooper(), request -> {
        worker.execute(() -> {
            JSONArray results = new JSONArray();
            try {
                JSONArray profiles = new JSONArray(request.getData().getString("profiles", "[]"));
                int timeout = request.getData().getInt("timeout");
                if (profiles.length() > 4 || profiles.length() == 0 || (timeout != 5 && timeout != 10))
                    throw new IllegalArgumentException();
                JSONArray configs = new JSONArray();
                for (int i = 0; i < profiles.length(); i++) {
                    JSONObject doc = Core.object("outbounds", new JSONArray().put(Core.outbound(profiles.getJSONObject(i))));
                    configs.put(Core.object("xrayJson", doc.toString(), "outboundTag", "proxy"));
                }
                JSONObject result = Core.call("pingBatch", Core.object(
                        "url", Core.HEALTH, "configs", configs, "timeout", timeout));
                results = result.getJSONArray("results");
            } catch (Exception failure) { }
            Message answer = Message.obtain();
            Bundle data = new Bundle();
            data.putString("results", results.toString());
            answer.setData(data);
            try { request.replyTo.send(answer); } catch (Exception gone) { }
        });
        return true;
    }));

    @Override public void onCreate() { super.onCreate(); Seq.setContext(this); }
    @Override public IBinder onBind(Intent intent) { return messenger.getBinder(); }
    @Override public void onDestroy() { worker.shutdownNow(); super.onDestroy(); }

    static JSONArray ping(Context context, JSONArray profiles, int seconds) throws Exception {
        CompletableFuture<Messenger> ready = new CompletableFuture<>();
        ServiceConnection link = new ServiceConnection() {
            @Override public void onServiceConnected(ComponentName name, IBinder binder) { ready.complete(new Messenger(binder)); }
            @Override public void onServiceDisconnected(ComponentName name) {
                ready.completeExceptionally(new IllegalStateException("Probe service stopped"));
            }
        };
        Intent intent = new Intent(context, ProbeService.class);
        if (!context.bindService(intent, link, Context.BIND_AUTO_CREATE)) throw new IllegalStateException("Could not start probe");
        try {
            CompletableFuture<JSONArray> result = new CompletableFuture<>();
            Message message = Message.obtain();
            Bundle data = new Bundle();
            data.putString("profiles", profiles.toString());
            data.putInt("timeout", seconds);
            message.setData(data);
            message.replyTo = new Messenger(new Handler(Looper.getMainLooper(), reply -> {
                try { result.complete(new JSONArray(reply.getData().getString("results", "[]"))); }
                catch (Exception bad) { result.completeExceptionally(bad); }
                return true;
            }));
            ready.get(7, TimeUnit.SECONDS).send(message);
            return result.get(seconds + 5L, TimeUnit.SECONDS);
        } finally {
            context.unbindService(link);
        }
    }
}
