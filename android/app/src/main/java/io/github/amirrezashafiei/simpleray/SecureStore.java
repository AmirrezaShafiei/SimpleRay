package io.github.amirrezashafiei.simpleray;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecureStore {
    private static final String KEY = "SimpleRayMobileProfiles";
    private static final Object LOCK = new Object();
    private final Context context;

    SecureStore(Context context) { this.context = context.getApplicationContext(); }

    String read(String name) throws Exception {
        synchronized (LOCK) {
            byte[] data;
            try { data = file(name).readFully(); }
            catch (FileNotFoundException missing) { return ""; }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Arrays.copyOf(data, 12)));
            return new String(cipher.doFinal(data, 12, data.length - 12), StandardCharsets.UTF_8);
        }
    }

    void write(String name, String value) throws Exception {
        synchronized (LOCK) {
            if (value.length() > 25_000_000) throw new IllegalArgumentException("Saved data exceeds the limit");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] data = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            AtomicFile file = file(name);
            FileOutputStream stream = file.startWrite();
            try {
                stream.write(cipher.getIV());
                stream.write(data);
                file.finishWrite(stream);
            } catch (Exception failure) {
                file.failWrite(stream);
                throw failure;
            }
        }
    }

    private AtomicFile file(String name) {
        if (!name.matches("config|prefs|launch|history")) throw new IllegalArgumentException("Unknown storage key");
        return new AtomicFile(new File(context.getNoBackupFilesDir(), name + ".enc"));
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        SecretKey existing = (SecretKey) store.getKey(KEY, null);
        if (existing != null) return existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
}
