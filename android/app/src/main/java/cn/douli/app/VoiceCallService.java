package cn.douli.app;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.*;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.NoiseSuppressor;
import android.os.*;
import java.util.*;
import java.util.concurrent.TimeUnit;
import okhttp3.*;
import okio.ByteString;
import org.json.*;

/** Owns microphone, playback and the local voice socket independently of WebView. */
public class VoiceCallService extends Service {
    public interface Listener { void onEvent(String json); }
    static volatile Listener listener;
    static volatile VoiceCallService current;
    static volatile String snapshot = "{\"type\":\"native_snapshot\",\"active\":false}";
    private static final String ORIGIN = "http://127.0.0.1:8788";
    private final Handler main = new Handler(Looper.getMainLooper());
    private HandlerThread thread;
    private Handler worker;
    private volatile boolean active, ready, muted, paused, focusPaused, ending;
    private boolean playbackPaused, bargeHold, acceptingOutput, outputEnded;
    private String status = "connecting", sessionId = "", caption = "", route = "auto";
    private boolean nativeReply;
    private int turnId, rejectedThrough = -1, oldAudioMode;
    private long writtenFrames, lastProgress;
    private AudioRecord recorder;
    private AudioTrack player;
    private AcousticEchoCanceler aec;
    private NoiseSuppressor noise;
    private AudioManager audio;
    private AudioFocusRequest focus;
    private AudioDeviceCallback deviceCallback;
    private Thread recordingThread;
    private PowerManager.WakeLock wake;
    private OkHttpClient client;
    private volatile WebSocket socket;
    private final ArrayDeque<Frame> pending = new ArrayDeque<>();
    private int pendingBytes;
    private final List<Segment> segments = new ArrayList<>();
    private Segment currentSegment;
    private static class Segment {
        int turn, id, totalMs = -1, lastReported = -1;
        long start = -1, written;
        boolean started;
    }
    private static class Frame {
        byte[] bytes; int offset; Segment segment;
        Frame(byte[] bytes, Segment segment) { this.bytes = bytes; this.segment = segment; }
    }
    static JSONObject json(Object... values) {
        JSONObject object = new JSONObject();
        try { for (int i = 0; i < values.length; i += 2) object.put((String)values[i], values[i + 1]); }
        catch (JSONException impossible) { throw new IllegalArgumentException(impossible); }
        return object;
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onCreate() {
        super.onCreate(); current = this;
        thread = new HandlerThread("douli-call"); thread.start(); worker = new Handler(thread.getLooper());
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        final String action = intent.getAction();
        if ("start".equals(action) && !active) {
            active = true;
            sessionId = intent.getStringExtra("sessionId"); if (sessionId == null) sessionId = "";
            notification(); // Foreground before requesting focus or opening the mic.
            final String mode = intent.getStringExtra("route");
            worker.post(() -> startCall(mode == null ? "auto" : mode));
        } else if ("command".equals(action) && active) {
            final String command = intent.getStringExtra("command");
            worker.post(() -> { try { command(new JSONObject(command)); } catch (Exception e) { fail("通话控制失败"); } });
        } else if ("stop".equals(action)) stopSelf();
        else if ("pause".equals(action) && active) worker.post(() -> control(paused ? "resume" : "pause", false));
        else if ("mute".equals(action) && active) worker.post(() -> control("mute", !muted));
        else if (!active) stopSelf();
        return START_NOT_STICKY; // Never restart a microphone after process death.
    }
    private void startCall(String mode) {
        try {
            if (!active) return;
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) throw new SecurityException();
            audio = getSystemService(AudioManager.class);
            oldAudioMode = audio.getMode();
            audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
            AudioAttributes attributes = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
            focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(attributes)
                .setAcceptsDelayedFocusGain(false).setOnAudioFocusChangeListener(this::focusChanged, worker).build();
            if (audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { fail("其他通话正在占用声音，请结束后再试"); return; }
            int inputBuffer = Math.max(6400, AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT));
            recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, 16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, inputBuffer);
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("microphone");
            if (AcousticEchoCanceler.isAvailable()) { aec = AcousticEchoCanceler.create(recorder.getAudioSessionId()); if (aec != null) aec.setEnabled(true); }
            if (NoiseSuppressor.isAvailable()) { noise = NoiseSuppressor.create(recorder.getAudioSessionId()); if (noise != null) noise.setEnabled(true); }
            player = new AudioTrack.Builder().setAudioAttributes(attributes)
                .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(16000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setBufferSizeInBytes(Math.max(6400, AudioTrack.getMinBufferSize(16000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)))
                .setTransferMode(AudioTrack.MODE_STREAM).build();
            if (player.getState() != AudioTrack.STATE_INITIALIZED) throw new IllegalStateException("speaker");
            player.play();
            wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Douli:VoiceCall");
            wake.acquire();
            deviceCallback = new AudioDeviceCallback() {
                @Override public void onAudioDevicesAdded(AudioDeviceInfo[] devices) { routes(); }
                @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] devices) { routes(); }
            };
            audio.registerAudioDeviceCallback(deviceCallback, worker);
            client = new OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS).connectTimeout(8, TimeUnit.SECONDS).build();
            HttpUrl.Builder url = HttpUrl.get(ORIGIN + "/api/voice").newBuilder().addQueryParameter("route", mode);
            if (!sessionId.isEmpty()) url.addQueryParameter("session", sessionId);
            socket = client.newWebSocket(new Request.Builder().url(url.build()).header("Origin", ORIGIN).build(), new WebSocketListener() {
                @Override public void onOpen(WebSocket ws, Response response) { worker.post(() -> send(json("type", "hello", "version", 1, "features", json("aec", aec != null && aec.getEnabled(), "voice_controls", true, "playback_ack", true), "audio_params", json("format", "pcm", "sample_rate", 16000, "channels", 1, "frame_duration", 20)))); }
                @Override public void onMessage(WebSocket ws, String text) { worker.post(() -> { if (active) { try { receive(new JSONObject(text)); } catch (Exception e) { fail("语音服务返回了无法处理的数据"); } } }); }
                @Override public void onMessage(WebSocket ws, ByteString bytes) {
                    // Bound buffering before posting work, too (the socket is local).
                    if (bytes.size() > 65536) { worker.post(() -> fail("语音帧过大")); return; }
                    worker.post(() -> enqueue(bytes.toByteArray()));
                }
                @Override public void onFailure(WebSocket ws, Throwable error, Response response) { worker.post(() -> { if (active) fail("语音连接已断开，请重新开始通话"); }); }
                @Override public void onClosing(WebSocket ws, int code, String reason) { ws.close(code, null); worker.post(() -> { if (active) stopSelf(); }); }
            });
            recordingThread = new Thread(this::record, "douli-microphone"); recordingThread.start();
            worker.post(tick); publish(); routes();
        } catch (Exception error) { fail("无法启动手机通话，请检查麦克风权限和音频设备"); }
    }
    private void record() {
        byte[] frame = new byte[640]; int offset = 0;
        try {
            while (active) {
                if (!ready || muted || paused || focusPaused) {
                    if (recorder.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) recorder.stop();
                    offset = 0; Thread.sleep(20); continue;
                }
                if (recorder.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) recorder.startRecording();
                int count = recorder.read(frame, offset, frame.length - offset, AudioRecord.READ_BLOCKING);
                if (count < 0) { if (!active) return; throw new IllegalStateException("read"); }
                offset += count;
                if (offset == frame.length) {
                    if (active && ready && !muted && !paused && !focusPaused && socket != null && socket.queueSize() < 128000) socket.send(ByteString.of(frame));
                    offset = 0;
                }
            }
        } catch (Exception error) { if (active) worker.post(() -> fail("麦克风已停止，请重新开始通话")); }
    }
    private void send(JSONObject message) { if ((active || ending) && socket != null) socket.send(message.toString()); }
    private void receive(JSONObject event) throws JSONException {
        String type = event.optString("type"); int id = event.optInt("turn_id", turnId);
        if (id < turnId && !"playback".equals(type) && !"farewell".equals(type)) return;
        if (event.has("session_id")) sessionId = event.optString("session_id");
        if ("hello".equals(type)) { ready = true; status = "listening"; send(json("type", "listen", "state", "start", "mode", "auto")); }
        if ("ping".equals(type)) send(json("type", "pong"));
        if ("voice_mode".equals(type)) nativeReply = "realtime".equals(event.optString("mode"));
        if ("stt".equals(type)) caption = "";
        if ("delta".equals(type) && nativeReply) { caption += event.optString("text"); if (caption.length() > 600) caption = caption.substring(caption.length() - 600); }
        if ("vision_request".equals(type) && ScreenShareService.current != null) {
            ScreenShareService.frame(id, frame -> worker.post(() -> send(frame))); return;
        }
        if ("voice_state".equals(type)) {
            turnId = Math.max(turnId, id);
            status = event.optBoolean("paused") ? "paused" : "idle".equals(event.optString("output")) ? "listening" : event.optString("output");
        }
        if ("barge".equals(type) && id == turnId) { bargeHold = "hold".equals(event.optString("state")); applyPlayback(); }
        if ("tts".equals(type)) {
            if (id <= rejectedThrough) return;
            String state = event.optString("state");
            if ("start".equals(state)) { stopPlayback(); turnId = id; acceptingOutput = true; outputEnded = false; bargeHold = false; status = "speaking"; applyPlayback(); }
            if ("sentence_start".equals(state) && acceptingOutput && id == turnId) {
                currentSegment = new Segment(); currentSegment.id = event.getInt("segment_id"); currentSegment.turn = id; segments.add(currentSegment); if (!nativeReply) caption = event.optString("text");
            }
            if ("sentence_end".equals(state)) for (Segment s : segments) if (s.turn == id && s.id == event.optInt("segment_id", -1)) s.totalMs = event.optInt("duration_ms");
            if ("stop".equals(state)) {
                if (event.optBoolean("interrupted")) { stopPlayback(); rejectedThrough = Math.max(rejectedThrough, id); caption = ""; bargeHold = false; applyPlayback(); }
                outputEnded = true;
            }
        }
        emit(event); publish();
        if ("farewell".equals(type)) stopSelf();
    }
    private void enqueue(byte[] bytes) {
        if (!active || !acceptingOutput || currentSegment == null || bytes.length % 2 != 0) return;
        if (pendingBytes + bytes.length > 320000) { fail("播放缓冲过长，通话已结束"); return; }
        pending.add(new Frame(bytes, currentSegment)); pendingBytes += bytes.length;
        pump();
    }
    private boolean held() { return paused || focusPaused || playbackPaused || bargeHold; }
    private void pump() {
        if (player == null || held()) return;
        while (!pending.isEmpty()) {
            Frame frame = pending.peek();
            int wrote = player.write(frame.bytes, frame.offset, frame.bytes.length - frame.offset, AudioTrack.WRITE_NON_BLOCKING);
            if (wrote < 0) { fail("扬声器播放失败"); return; }
            if (wrote == 0) return;
            if (frame.segment.start < 0) frame.segment.start = writtenFrames;
            frame.segment.written += wrote / 2; writtenFrames += wrote / 2;
            frame.offset += wrote; pendingBytes -= wrote;
            if (frame.offset == frame.bytes.length) pending.remove();
        }
    }
    private final Runnable tick = new Runnable() { public void run() {
        if (!active) return;
        pump();
        if (SystemClock.elapsedRealtime() - lastProgress >= 100) { receipts(false); lastProgress = SystemClock.elapsedRealtime(); }
        if (outputEnded && pending.isEmpty() && player != null && Integer.toUnsignedLong(player.getPlaybackHeadPosition()) >= writtenFrames && !"listening".equals(status)) { status = "listening"; publish(); }
        worker.postDelayed(this, 20);
    }};
    private void receipts(boolean interrupted) {
        if (player == null) return;
        long head = Integer.toUnsignedLong(player.getPlaybackHeadPosition());
        for (Segment s : segments) {
            int played = s.start < 0 ? 0 : (int)(Math.max(0, Math.min(s.written, head - s.start)) / 16);
            if (played <= s.lastReported && !interrupted) continue;
            String state = interrupted ? "interrupted" : !s.started && played > 0 ? "started" : s.totalMs >= 0 && played >= s.totalMs ? "complete" : "progress";
            if (played > 0) s.started = true;
            s.lastReported = played;
            send(json("type", "playback", "turn_id", s.turn, "segment_id", s.id, "played_ms", played, "state", state));
        }
    }
    private void stopPlayback() {
        receipts(true); acceptingOutput = false; pending.clear(); pendingBytes = 0; segments.clear(); currentSegment = null;
        if (player != null) { player.pause(); player.flush(); writtenFrames = 0; if (!held()) player.play(); }
    }
    private void applyPlayback() { if (player != null) { if (held()) player.pause(); else player.play(); } }
    private void control(String action, boolean enabled) {
        if (!active) return;
        if ("mute".equals(action)) muted = enabled;
        if ("pause".equals(action)) paused = true;
        if ("resume".equals(action)) paused = false;
        if ("playback_pause".equals(action)) playbackPaused = true;
        if ("playback_resume".equals(action)) playbackPaused = false;
        send(json("type", "voice_control", "action", "resume".equals(action) && focusPaused ? "pause" : action, "enabled", enabled));
        applyPlayback(); notification(); publish();
    }
    private void command(JSONObject command) throws JSONException {
        String type = command.optString("type");
        if ("voice_control".equals(type)) control(command.optString("action"), command.optBoolean("enabled"));
        else if ("end".equals(type)) stopSelf();
        else if ("audio_route".equals(type)) selectRoute(command.optString("route"));
        else if ("abort".equals(type)) { stopPlayback(); rejectedThrough = Math.max(rejectedThrough, turnId); bargeHold = false; caption = ""; applyPlayback(); send(command); }
        else if ("listen".equals(type) || "text".equals(type) || "vision".equals(type) || "vision_frame".equals(type)) send(command);
    }
    private void focusChanged(int change) {
        if (!active) return;
        if (change == AudioManager.AUDIOFOCUS_LOSS) { emit(json("type", "error", "message", "声音已交给其他通话，豆梨通话已结束")); stopSelf(); return; }
        focusPaused = change != AudioManager.AUDIOFOCUS_GAIN;
        send(json("type", "voice_control", "action", paused || focusPaused ? "pause" : "resume"));
        applyPlayback(); notification(); publish();
    }
    private void selectRoute(String selected) {
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                if ("auto".equals(selected)) audio.clearCommunicationDevice();
                else {
                    AudioDeviceInfo found = null;
                    for (AudioDeviceInfo d : audio.getAvailableCommunicationDevices()) {
                        int t = d.getType();
                        if (("speaker".equals(selected) && t == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) || ("earpiece".equals(selected) && t == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) || ("bluetooth".equals(selected) && (t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || t == AudioDeviceInfo.TYPE_BLE_HEADSET))) { found = d; break; }
                    }
                    if (found == null || !audio.setCommunicationDevice(found)) { emit(json("type", "error", "message", "所选音频设备当前不可用")); return; }
                }
            } else {
                if ("bluetooth".equals(selected)) { audio.startBluetoothSco(); audio.setBluetoothScoOn(true); }
                else { audio.stopBluetoothSco(); audio.setBluetoothScoOn(false); audio.setSpeakerphoneOn("speaker".equals(selected)); }
            }
            route = selected; routes();
        } catch (SecurityException e) { emit(json("type", "error", "message", "请允许附近设备权限后选择蓝牙耳机")); }
    }
    private void routes() { emit(json("type", "audio_route", "route", route)); }
    static void screenEvent(boolean sharing) {
        VoiceCallService call = current;
        if (call == null) return;
        call.worker.post(() -> {
            call.send(json("type", "vision", "action", sharing ? "start" : "stop", "source", "screen"));
            call.emit(json("type", "native_screen", "active", sharing)); call.publish();
        });
    }
    static boolean isActive() { VoiceCallService call = current; return call != null && call.active && !call.ending; }
    static void screenError() { VoiceCallService call = current; if (call != null) call.emit(json("type", "error", "message", "屏幕分享未能启动，请重新授权后再试")); }
    private void publish() {
        if (current != null && current != this) return;
        snapshot = json("type", "native_snapshot", "active", active, "session_id", sessionId, "status", paused || focusPaused ? "paused" : status, "turn_id", turnId, "paused", paused || focusPaused, "muted", muted, "playbackPaused", playbackPaused, "caption", caption, "audioRoute", route, "screenSharing", ScreenShareService.current != null).toString();
        Listener callback = listener; if (callback != null) callback.onEvent(snapshot);
    }
    private void emit(JSONObject event) { Listener callback = listener; if (callback != null) callback.onEvent(event.toString()); }
    private void fail(String message) { if (active) emit(json("type", "error", "message", message)); stopSelf(); }
    private void notification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("voice", "语音通话", NotificationManager.IMPORTANCE_LOW));
        Notification.Builder builder = new Notification.Builder(this, "voice").setSmallIcon(R.drawable.ic_douli).setContentTitle("豆梨语音通话")
            .setContentText(paused || focusPaused ? "通话已暂停" : muted ? "麦克风已静音" : "正在通话 · 点击返回")
            .setContentIntent(PendingIntent.getActivity(this, 20, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE))
            .setOngoing(true).setCategory(Notification.CATEGORY_CALL).setVisibility(Notification.VISIBILITY_PRIVATE);
        String[] actions = {"mute", "pause", "stop"}; String[] labels = {muted ? "取消静音" : "静音", paused ? "继续" : "暂停", "结束"};
        for (int i = 0; i < actions.length; i++) builder.addAction(new Notification.Action.Builder(null, labels[i], PendingIntent.getService(this, 21 + i, new Intent(this, VoiceCallService.class).setAction(actions[i]), PendingIntent.FLAG_IMMUTABLE)).build());
        if (Build.VERSION.SDK_INT >= 30) startForeground(2, builder.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE | ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(2, builder.build());
    }
    @Override public void onDestroy() {
        if (current == this) current = null;
        stopService(new Intent(this, ScreenShareService.class));
        ending = true; active = false; ready = false;
        worker.post(() -> {
            // Stop the native recorder even if the page was destroyed long ago.
            if (recorder != null) { try { recorder.stop(); } catch (IllegalStateException ignored) {} }
            if (recordingThread != null) try { recordingThread.join(500); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            if (player != null) { stopPlayback(); player.release(); player = null; }
            if (socket != null) {
                send(json("type", "abort"));
                WebSocket closing = socket;
                closing.close(1000, "call ended");
                main.postDelayed(closing::cancel, 3000);
                socket = null;
            }
            if (aec != null) aec.release(); if (noise != null) noise.release();
            if (recorder != null) { recorder.release(); recorder = null; }
            if (audio != null) {
                if (deviceCallback != null) audio.unregisterAudioDeviceCallback(deviceCallback);
                if (focus != null) audio.abandonAudioFocusRequest(focus);
                if (Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice();
                else { audio.stopBluetoothSco(); audio.setBluetoothScoOn(false); audio.setSpeakerphoneOn(false); }
                audio.setMode(oldAudioMode);
            }
            if (client != null) { client.dispatcher().executorService().shutdown(); client.connectionPool().evictAll(); }
            if (wake != null && wake.isHeld()) wake.release();
            ending = false; status = "off"; publish(); worker.removeCallbacksAndMessages(null); thread.quitSafely();
        });
        stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy();
    }
}
