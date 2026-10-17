package cn.douli.app;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.graphics.*;
import android.hardware.display.*;
import android.media.*;
import android.media.projection.*;
import android.os.*;
import android.util.*;
import android.view.WindowManager;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.function.Consumer;
import org.json.JSONObject;

/** Explicit, system-consented screen sharing. Frames live only in memory. */
public class ScreenShareService extends Service {
    static volatile ScreenShareService current;
    private HandlerThread thread;
    private Handler worker;
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private volatile boolean ended;
    private boolean starting;
    private String latestFrame;
    private long capturedAt, lastCapture;
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onCreate() {
        super.onCreate(); current = this;
        thread = new HandlerThread("douli-screen"); thread.start(); worker = new Handler(thread.getLooper());
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || "stop".equals(intent.getAction())) { stopSelf(); return START_NOT_STICKY; }
        if (!VoiceCallService.isActive()) { stopSelf(); return START_NOT_STICKY; }
        if (starting) return START_NOT_STICKY;
        starting = true;
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("screen", "屏幕分享", NotificationManager.IMPORTANCE_LOW));
        PendingIntent stop = PendingIntent.getService(this, 30, new Intent(this, ScreenShareService.class).setAction("stop"), PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, "screen").setSmallIcon(R.drawable.ic_douli).setContentTitle("豆梨正在共享屏幕")
            .setContentText("提问时发送一帧画面 · 点击停止分享").setContentIntent(stop).setOngoing(true)
            .addAction(new Notification.Action.Builder(null, "停止分享", stop).build()).build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(3, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        else startForeground(3, notification);
        worker.post(() -> {
            try {
                if (ended) return;
                Intent consent = intent.getParcelableExtra("consent");
                projection = getSystemService(MediaProjectionManager.class).getMediaProjection(intent.getIntExtra("result", Activity.RESULT_CANCELED), consent);
                if (projection == null) throw new IllegalStateException();
                projection.registerCallback(new MediaProjection.Callback() {
                    @Override public void onStop() { stopSelf(); }
                    @Override public void onCapturedContentResize(int width, int height) { if (!ended) resize(width, height); }
                }, worker);
                DisplayMetrics metrics = new DisplayMetrics();
                getSystemService(WindowManager.class).getDefaultDisplay().getRealMetrics(metrics);
                makeReader(metrics.widthPixels, metrics.heightPixels);
                display = projection.createVirtualDisplay("DouliSharedScreen", reader.getWidth(), reader.getHeight(), metrics.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, worker);
                VoiceCallService.screenEvent(true);
            } catch (Exception error) { VoiceCallService.screenError(); stopSelf(); }
        });
        return START_NOT_STICKY;
    }
    private void makeReader(int width, int height) {
        double scale = Math.min(1, 1024.0 / Math.max(width, height));
        reader = ImageReader.newInstance(Math.max(1, (int)(width * scale)), Math.max(1, (int)(height * scale)), PixelFormat.RGBA_8888, 2);
        reader.setOnImageAvailableListener(source -> capture(source), worker);
    }
    private void resize(int width, int height) {
        if (display == null || width <= 0 || height <= 0) return;
        ImageReader old = reader;
        makeReader(width, height);
        display.resize(reader.getWidth(), reader.getHeight(), getResources().getDisplayMetrics().densityDpi);
        display.setSurface(reader.getSurface()); old.close(); latestFrame = null;
    }
    private void capture(ImageReader source) {
        if (ended) return;
        try (Image frame = source.acquireLatestImage()) {
            if (frame == null || SystemClock.elapsedRealtime() - lastCapture < 700) return;
            lastCapture = SystemClock.elapsedRealtime();
            Image.Plane plane = frame.getPlanes()[0]; ByteBuffer bytes = plane.getBuffer();
            int width = frame.getWidth(), height = frame.getHeight();
            int paddedWidth = plane.getRowStride() / plane.getPixelStride();
            Bitmap padded = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888);
            Bitmap cropped = null;
            try {
                int required = paddedWidth * height * 4;
                if (bytes.remaining() < required) {
                    ByteBuffer aligned = ByteBuffer.allocate(required); aligned.put(bytes); aligned.rewind(); bytes = aligned;
                }
                padded.copyPixelsFromBuffer(bytes);
                cropped = Bitmap.createBitmap(padded, 0, 0, width, height);
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                cropped.compress(Bitmap.CompressFormat.JPEG, 72, output);
                if (output.size() > 500000) { output.reset(); cropped.compress(Bitmap.CompressFormat.JPEG, 40, output); }
                if (output.size() <= 500000) { latestFrame = "data:image/jpeg;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP); capturedAt = System.currentTimeMillis(); }
            } finally { if (cropped != null && cropped != padded) cropped.recycle(); padded.recycle(); }
        } catch (Exception ignored) { latestFrame = null; }
    }
    static void frame(int turnId, Consumer<JSONObject> receive) {
        ScreenShareService service = current;
        if (service == null || service.ended) { receive.accept(VoiceCallService.json("type", "vision_frame", "turn_id", turnId, "unavailable", true)); return; }
        service.worker.post(() -> {
            boolean valid = !service.ended && service.latestFrame != null && System.currentTimeMillis() - service.capturedAt < 15000;
            receive.accept(valid ? VoiceCallService.json("type", "vision_frame", "turn_id", turnId, "source", "screen", "capturedAt", service.capturedAt, "dataUrl", service.latestFrame) : VoiceCallService.json("type", "vision_frame", "turn_id", turnId, "unavailable", true));
        });
    }
    @Override public void onDestroy() {
        ended = true; if (current == this) current = null;
        VoiceCallService.screenEvent(false);
        worker.post(() -> {
            if (display != null) display.release(); if (reader != null) reader.close(); if (projection != null) projection.stop();
            latestFrame = null; worker.removeCallbacksAndMessages(null); thread.quitSafely();
        });
        stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy();
    }
}
