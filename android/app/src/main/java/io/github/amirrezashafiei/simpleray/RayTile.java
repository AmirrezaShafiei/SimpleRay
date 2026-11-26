package io.github.amirrezashafiei.simpleray;

import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.content.Intent;
import android.net.VpnService;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

public final class RayTile extends TileService {
    @Override public void onStartListening() {
        super.onStartListening();
        Tile tile = getQsTile();
        if (tile == null) return;
        tile.setLabel("SimpleRAY");
        tile.setSubtitle(RayVpn.label(RayVpn.status().optString("phase")));
        tile.setState(RayVpn.running() ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        tile.updateTile();
    }

    @Override public void onClick() {
        super.onClick();
        if (RayVpn.running()) { RayVpn.stop(this); return; }
        try {
            if (VpnService.prepare(this) == null && !new SecureStore(this).read("launch").isBlank()) {
                RayVpn.start(this, null);
                return;
            }
        } catch (Exception unavailable) { }
        open();
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    @SuppressWarnings("deprecation")
    private void open() {
        Intent intent = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 1, intent, PendingIntent.FLAG_IMMUTABLE));
        } else {
            // The PendingIntent overload is available on API 34+.
            startActivityAndCollapse(intent);
        }
    }
}
