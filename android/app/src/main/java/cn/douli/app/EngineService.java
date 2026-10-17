package cn.douli.app;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.net.*;
import android.net.wifi.WifiManager;
import android.os.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.zip.*;
import org.json.*;

public class EngineService extends Service {
    static { System.loadLibrary("node"); System.loadLibrary("douli"); }
    private static native int runNode(String root, String data, String token);
    private boolean started;
    private volatile boolean stopping;
    private PowerManager.WakeLock wake;
    private WifiManager.MulticastLock multicast;
    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback networks;
    private final String token = UUID.randomUUID().toString();

    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "stop".equals(intent.getAction())) { stopSelf(); return START_NOT_STICKY; }
        if (started) return START_STICKY;
        started = true;
        new File(getFilesDir(), "startup-error.txt").delete();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("engine", "ESP32 连接服务", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, EngineService.class).setAction("stop"), PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, "engine")
            .setSmallIcon(cn.douli.app.R.drawable.ic_douli).setContentTitle("豆梨正在运行")
            .setContentText("手机为 ESP32 提供服务 · 点击打开")
            .setContentIntent(open).setOngoing(true).addAction(new Notification.Action.Builder(null, "停止服务", stop).build()).build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        else startForeground(1, notification);
        wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Douli:ESP32");
        wake.acquire();
        WifiManager wifi = (WifiManager)getApplicationContext().getSystemService(WIFI_SERVICE);
        multicast = wifi.createMulticastLock("Douli:discovery");
        multicast.setReferenceCounted(false); multicast.acquire();
        connectivity = getSystemService(ConnectivityManager.class);
        networks = new ConnectivityManager.NetworkCallback() {
            @Override public void onLinkPropertiesChanged(Network n, LinkProperties p) { saveNetworks(); }
            @Override public void onCapabilitiesChanged(Network n, NetworkCapabilities c) { saveNetworks(); }
            @Override public void onLost(Network n) { saveNetworks(); }
        };
        connectivity.registerNetworkCallback(new NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(), networks);
        saveNetworks();
        new Thread(() -> {
            try {
                File root = unpack();
                if (!stopping) runNode(root.getAbsolutePath(), dataDir().getAbsolutePath(), token);
            } catch (Throwable error) {
                try { Files.write(new File(getFilesDir(), "startup-error.txt").toPath(), error.toString().getBytes(StandardCharsets.UTF_8)); } catch (IOException ignored) {}
            } finally {
                stopSelf();
                // Node cannot be started twice in one process. This service has its own process.
                android.os.Process.killProcess(android.os.Process.myPid());
            }
        }, "douli-node").start();
        return START_STICKY;
    }
    private File dataDir() { File dir = new File(getFilesDir(), "data"); dir.mkdirs(); return dir; }
    private synchronized void saveNetworks() {
        try {
            JSONArray addresses = new JSONArray();
            for (Network net : connectivity.getAllNetworks()) {
                NetworkCapabilities caps = connectivity.getNetworkCapabilities(net);
                LinkProperties links = connectivity.getLinkProperties(net);
                // A VPN can also advertise the transport of its underlying Wi-Fi.
                // Only publish the physical LAN address for ESP32 and multicast.
                if (caps == null || links == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                    || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
                    || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)) continue;
                for (LinkAddress link : links.getLinkAddresses())
                    if (link.getAddress() instanceof Inet4Address && !link.getAddress().isLoopbackAddress()) addresses.put(link.getAddress().getHostAddress());
            }
            File next = new File(dataDir(), "network.json.tmp");
            Files.write(next.toPath(), addresses.toString().getBytes(StandardCharsets.UTF_8));
            Files.move(next.toPath(), new File(dataDir(), "network.json").toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        } catch (Exception ignored) {}
    }
    private File unpack() throws Exception {
        String version;
        try (InputStream input = getAssets().open("runtime-version.txt")) { version = new String(readBytes(input), StandardCharsets.UTF_8).trim(); }
        if (!version.matches("[a-f0-9]{64}")) throw new IOException("Invalid runtime checksum");
        File root = new File(getFilesDir(), "runtime-" + version);
        File complete = new File(root, ".complete");
        if (complete.exists()) return root;
        root.mkdirs();
        String prefix = root.getCanonicalPath() + File.separator;
        try (ZipInputStream zip = new ZipInputStream(getAssets().open("runtime.zip"))) {
            ZipEntry entry;
            byte[] bytes = new byte[65536];
            while ((entry = zip.getNextEntry()) != null) {
                File file = new File(root, entry.getName());
                if (!file.getCanonicalPath().startsWith(prefix)) throw new IOException("Invalid asset path");
                if (entry.isDirectory()) { file.mkdirs(); continue; }
                file.getParentFile().mkdirs();
                try (FileOutputStream out = new FileOutputStream(file)) {
                    int count; while ((count = zip.read(bytes)) > 0) out.write(bytes, 0, count);
                }
            }
        }
        complete.createNewFile();
        return root;
    }
    @Override public void onDestroy() {
        stopping = true;
        if (wake != null && wake.isHeld()) wake.release();
        if (multicast != null && multicast.isHeld()) multicast.release();
        if (connectivity != null && networks != null) connectivity.unregisterNetworkCallback(networks);
        new Thread(() -> {
            try {
                HttpURLConnection request = (HttpURLConnection)new URL("http://127.0.0.1:8788/api/mobile/stop").openConnection();
                request.setConnectTimeout(2000); request.setReadTimeout(2000);
                request.setRequestMethod("POST"); request.setRequestProperty("Authorization", "Bearer " + token);
                request.getInputStream().close(); request.disconnect();
                Thread.sleep(1500);
            } catch (Exception ignored) {}
            android.os.Process.killProcess(android.os.Process.myPid());
        }, "douli-stop").start();
        super.onDestroy();
    }
    static byte[] readBytes(InputStream input) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] bytes = new byte[8192];
        int count; while ((count = input.read(bytes)) != -1) out.write(bytes,0,count);
        return out.toByteArray();
    }
}
