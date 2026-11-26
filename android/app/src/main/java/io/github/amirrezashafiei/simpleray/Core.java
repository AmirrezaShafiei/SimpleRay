package io.github.amirrezashafiei.simpleray;

import org.json.JSONArray;
import org.json.JSONObject;
import libXray.LibXray;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

final class Core {
    static final String HEALTH = "https://www.google.com/generate_204";
    static final String BACKUP = "https://cp.cloudflare.com/generate_204";

    static JSONObject object(Object... fields) {
        JSONObject result = new JSONObject();
        try {
            for (int i = 0; i < fields.length; i += 2)
                result.put((String) fields[i], fields[i + 1] == null ? JSONObject.NULL : fields[i + 1]);
        } catch (Exception impossible) { throw new IllegalArgumentException(impossible); }
        return result;
    }

    static JSONObject call(String method, JSONObject payload) throws Exception {
        JSONObject result = new JSONObject(LibXray.invoke(object(
                "apiVersion", 3, "method", method, "payload", payload).toString()));
        if (!result.optBoolean("success")) throw new IllegalArgumentException("Xray could not use this configuration");
        JSONObject data = result.optJSONObject("data");
        return data == null ? new JSONObject() : data;
    }

    static JSONObject outbound(JSONObject profile) throws Exception {
        JSONObject result = new JSONObject(profile.getJSONObject("outbound").toString());
        result.put("tag", "proxy");
        return result;
    }

    static int freePort() throws Exception {
        try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            return socket.getLocalPort();
        }
    }

    static JSONObject config(JSONObject profile, JSONObject routing, int tunnelPort, int probePort,
                             String user, String secret) throws Exception {
        JSONObject normal = inbound("android-tunnel", tunnelPort, user, secret, true);
        JSONObject probe = inbound("android-probe", probePort, user, secret, false);
        normal.put("sniffing", object("enabled", true, "routeOnly", true,
                "destOverride", new JSONArray().put("http").put("tls").put("quic")));
        JSONArray rules = new JSONArray()
                .put(object("type", "field", "inboundTag", new JSONArray().put("android-probe").put("android-doh"),
                        "outboundTag", "proxy"))
                .put(object("type", "field", "inboundTag", new JSONArray().put("android-tunnel"), "port", 53,
                        "outboundTag", "dns"));
        JSONArray domains = routing == null ? null : routing.optJSONArray("domains");
        if (domains != null) {
            for (int i = 0; i < domains.length(); i++) {
                JSONObject domain = domains.getJSONObject(i);
                String host = domain.getString("host");
                if (!host.matches("[a-z0-9.-]{1,253}")) throw new IllegalArgumentException("Invalid route");
                String pattern = (domain.optBoolean("suffix", true) ? "domain:" : "full:") + host;
                rules.put(object("type", "field", "domain", new JSONArray().put(pattern), "outboundTag",
                        "direct".equals(domain.optString("mode")) ? "direct" : "proxy"));
            }
        }
        return object("log", object("loglevel", "none"),
                "dns", object("servers", new JSONArray().put("https://1.1.1.1/dns-query"), "tag", "android-doh"),
                "inbounds", new JSONArray().put(normal).put(probe),
                "outbounds", new JSONArray().put(outbound(profile)).put(object("tag", "direct", "protocol", "freedom"))
                        .put(object("tag", "dns", "protocol", "dns", "settings", object("nonIPQuery", "skip"))),
                "routing", object("domainStrategy", "AsIs", "rules", rules));
    }

    private static JSONObject inbound(String tag, int port, String user, String secret, boolean udp) {
        return object("tag", tag, "listen", "127.0.0.1", "port", port, "protocol", "socks",
                "settings", object("auth", "password", "udp", udp, "ip", "127.0.0.1",
                        "accounts", new JSONArray().put(object("user", user, "pass", secret))));
    }

    record Reply(int status, byte[] body, long bytes, long elapsed) {}

    static Reply fetchThrough(int port, String user, String pass, String url, int limit, boolean keepBody,
                              int timeout) throws Exception {
        URI endpoint = URI.create(url);
        String host = endpoint.getHost();
        byte[] address = host.getBytes(StandardCharsets.US_ASCII);
        long started = android.os.SystemClock.elapsedRealtime();
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress("127.0.0.1", port), timeout);
            socket.setSoTimeout(timeout);
            DataInputStream input = new DataInputStream(socket.getInputStream());
            var output = socket.getOutputStream();
            output.write(new byte[]{5, 1, 2});
            if (input.readUnsignedByte() != 5 || input.readUnsignedByte() != 2) throw new EOFException();
            byte[] name = user.getBytes(StandardCharsets.US_ASCII);
            byte[] secret = pass.getBytes(StandardCharsets.US_ASCII);
            output.write(1); output.write(name.length); output.write(name);
            output.write(secret.length); output.write(secret);
            if (input.readUnsignedByte() != 1 || input.readUnsignedByte() != 0) throw new EOFException();
            output.write(new byte[]{5, 1, 0, 3, (byte) address.length}); output.write(address);
            output.write(new byte[]{1, (byte) 187});
            if (input.readUnsignedByte() != 5 || input.readUnsignedByte() != 0) throw new EOFException();
            input.readUnsignedByte();
            int addressSize = switch (input.readUnsignedByte()) {
                case 1 -> 4;
                case 3 -> input.readUnsignedByte();
                case 4 -> 16;
                default -> throw new EOFException();
            };
            input.readFully(new byte[addressSize + 2]);
            SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
            try (SSLSocket tls = (SSLSocket) factory.createSocket(socket, host, 443, true)) {
                var params = tls.getSSLParameters();
                params.setEndpointIdentificationAlgorithm("HTTPS");
                tls.setSSLParameters(params);
                tls.startHandshake();
                String path = endpoint.getRawPath();
                if (endpoint.getRawQuery() != null) path += "?" + endpoint.getRawQuery();
                tls.getOutputStream().write(("GET " + path + " HTTP/1.1\r\nHost: " + host
                        + "\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                BufferedInputStream stream = new BufferedInputStream(tls.getInputStream());
                String[] parts = line(stream).split(" ", 3);
                if (parts.length < 2) throw new EOFException();
                int status = Integer.parseInt(parts[1]);
                boolean chunked = false;
                for (int i = 0; i < 80; i++) {
                    String header = line(stream);
                    if (header.isEmpty()) break;
                    if (header.toLowerCase(java.util.Locale.ROOT).startsWith("transfer-encoding:"))
                        chunked = header.toLowerCase(java.util.Locale.ROOT).contains("chunked");
                }
                ByteArrayOutputStream body = new ByteArrayOutputStream();
                int bytes = 0;
                byte[] buffer = new byte[8192];
                while (bytes < limit) {
                    int chunk = chunked ? Integer.parseInt(line(stream).split(";", 2)[0].trim(), 16) : limit - bytes;
                    if (chunk <= 0) break;
                    int remaining = Math.min(chunk, limit - bytes);
                    while (remaining > 0) {
                        int n = stream.read(buffer, 0, Math.min(buffer.length, remaining));
                        if (n < 0) break;
                        if (keepBody) body.write(buffer, 0, n);
                        remaining -= n;
                        bytes += n;
                    }
                    if (!chunked || remaining > 0 || bytes >= limit) break;
                    line(stream);
                }
                return new Reply(status, body.toByteArray(), bytes,
                        Math.max(1, android.os.SystemClock.elapsedRealtime() - started));
            }
        }
    }

    private static String line(InputStream stream) throws Exception {
        ByteArrayOutputStream text = new ByteArrayOutputStream();
        while (text.size() < 8192) {
            int value = stream.read();
            if (value < 0) throw new EOFException();
            if (value == '\n') return text.toString(StandardCharsets.US_ASCII.name()).trim();
            if (value != '\r') text.write(value);
        }
        throw new EOFException();
    }

    static long health(int port, String user, String secret) {
        for (String endpoint : new String[]{HEALTH, BACKUP}) {
            try {
                Reply reply = fetchThrough(port, user, secret, endpoint, 0, false, 3000);
                if (reply.status() == 204) return reply.elapsed();
            } catch (Exception unavailable) { }
        }
        return -1;
    }
}
