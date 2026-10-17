package cn.douli.app;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import org.json.*;

public class MainActivity extends Activity {
    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private TextView status;
    private Button toggle;
    private boolean running, loaded, foreground;
    private PermissionRequest microphone;
    private JSONObject pendingVoice, pendingRoute;
    private final VoiceCallService.Listener voiceListener = json -> main.post(() -> {
        if (foreground && web != null && web.getUrl() != null && local(Uri.parse(web.getUrl())))
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('douli-native-voice',{detail:" + json + "}))", null);
    });
    private String exportUrl;
    private ValueCallback<Uri[]> fileSelection;
    private static final String ORIGIN = "http://127.0.0.1:8788";
    private boolean local(Uri uri) { return "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost()) && uri.getPort() == 8788; }

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (savedInstanceState != null) exportUrl = savedInstanceState.getString("exportUrl");
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(246,245,240));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        LinearLayout bar = new LinearLayout(this); bar.setGravity(Gravity.CENTER_VERTICAL); bar.setPadding(16,4,16,4);
        status = new TextView(this); status.setText("豆梨 · 服务未启动"); status.setTextSize(12);
        bar.addView(status, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        toggle = new Button(this); toggle.setText("启动服务"); toggle.setTextSize(12);
        toggle.setOnClickListener(v -> {
            if (running) { stopService(new Intent(this, EngineService.class)); loaded = false; welcome(); }
            else {
                if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 2);
                startForegroundService(new Intent(this, EngineService.class));
                status.setText("豆梨 · 正在启动…");
            }
        });
        bar.addView(toggle);
        Button battery = new Button(this); battery.setText("⋮"); battery.setMinWidth(0); battery.setMinimumWidth(0); battery.setContentDescription("更多选项");
        battery.setOnClickListener(v -> {
            PopupMenu menu = new PopupMenu(this,battery);
            menu.getMenu().add("后台设置"); menu.getMenu().add("运行诊断"); menu.getMenu().add("刷新页面");
            menu.setOnMenuItemClickListener(item -> {
                if ("后台设置".contentEquals(item.getTitle())) startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
                else if ("运行诊断".contentEquals(item.getTitle())) diagnostics();
                else { loaded=false; }
                return true;
            }); menu.show();
        });
        bar.addView(battery); root.addView(bar);
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(true);
        web.getSettings().setMediaPlaybackRequiresUserGesture(false);
        web.setDownloadListener((url,agent,disposition,mime,size) -> {
            Uri uri=Uri.parse(url);
            if (!local(uri) || !(uri.getPath().matches("/api/sessions/[a-f0-9-]+/export") || "/api/medical/export".equals(uri.getPath()))) return;
            exportUrl=url;
            startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("application/json").putExtra(Intent.EXTRA_TITLE,uri.getPath().startsWith("/api/medical") ? "douli-health.json" : "douli-conversation.json"),77);
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                if (!local(Uri.parse(url))) return;
                view.evaluateJavascript("window.douliNativeVoice={send:function(v){return JSON.parse(window.prompt('douli.voice.v1',JSON.stringify(v))||'{}')}};window.dispatchEvent(new Event('douli-native-ready'))", null);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (local(request.getUrl())) return false;
                if (request.isForMainFrame() && ("https".equals(request.getUrl().getScheme()) || "http".equals(request.getUrl().getScheme())))
                    startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (!foreground || !local(Uri.parse(view.getUrl()))) return false;
                if (fileSelection != null) fileSelection.onReceiveValue(null);
                fileSelection = callback;
                Intent chooser = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"image/jpeg","image/png","image/webp","application/pdf"});
                try { startActivityForResult(chooser,78); }
                catch (ActivityNotFoundException error) { fileSelection.onReceiveValue(null); fileSelection=null; }
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request) {
                if (!foreground || !local(request.getOrigin())) { request.deny(); return; }
                java.util.ArrayList<String> needed = new java.util.ArrayList<>();
                for (String resource : request.getResources()) {
                    String permission = PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) ? Manifest.permission.RECORD_AUDIO : PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource) ? Manifest.permission.CAMERA : null;
                    if (permission == null) { request.deny(); return; }
                    if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) needed.add(permission);
                }
                if (needed.isEmpty()) request.grant(request.getResources());
                else { if (microphone != null) microphone.deny(); microphone = request; requestPermissions(needed.toArray(new String[0]), 1); }
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) { if (microphone == request) microphone = null; }
            @Override public boolean onJsAlert(WebView v, String u, String text, JsResult result) {
                new AlertDialog.Builder(MainActivity.this).setMessage(text).setPositiveButton("确定", (d,w) -> result.confirm()).setOnCancelListener(d -> result.cancel()).show(); return true;
            }
            @Override public boolean onJsConfirm(WebView v, String u, String text, JsResult result) {
                new AlertDialog.Builder(MainActivity.this).setMessage(text).setPositiveButton("确定", (d,w) -> result.confirm()).setNegativeButton("取消", (d,w) -> result.cancel()).setOnCancelListener(d -> result.cancel()).show(); return true;
            }
            @Override public boolean onJsPrompt(WebView v, String u, String text, String value, JsPromptResult result) {
                if ("douli.voice.v1".equals(text)) {
                    if (!local(Uri.parse(u)) || v.getUrl() == null || !local(Uri.parse(v.getUrl()))) { result.cancel(); return true; }
                    try { result.confirm(voiceCommand(new JSONObject(value)).toString()); }
                    catch (Exception error) { result.confirm(VoiceCallService.json("error", "手机通话控制失败").toString()); }
                    return true;
                }
                EditText input = new EditText(MainActivity.this); input.setText(value);
                new AlertDialog.Builder(MainActivity.this).setMessage(text).setView(input).setPositiveButton("确定", (d,w) -> result.confirm(input.getText().toString())).setNegativeButton("取消", (d,w) -> result.cancel()).setOnCancelListener(d -> result.cancel()).show(); return true;
            }
        });
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1)); setContentView(root);
        welcome();
    }
    private final Runnable poll = new Runnable() { public void run() {
        if (!foreground) return;
        new Thread(() -> {
            boolean healthy = false;
            String error = "服务未启动";
            try {
                HttpURLConnection request = (HttpURLConnection)new URL(ORIGIN + "/api/health").openConnection();
                request.setConnectTimeout(800); request.setReadTimeout(800);
                try (InputStream input = request.getInputStream()) {
                    JSONObject data = new JSONObject(new String(readBytes(input), StandardCharsets.UTF_8));
                    healthy = data.optBoolean("ok") && "douli-esp32".equals(data.optString("name"));
                } finally { request.disconnect(); }
            } catch (Exception ignored) {
                File failure = new File(getFilesDir(), "startup-error.txt");
                if (failure.exists()) error = "启动失败，请查看诊断";
            }
            final boolean ready = healthy; final String message = error;
            main.post(() -> {
                if (!foreground) return;
                running = ready;
                status.setText(ready ? "豆梨 · 手机服务运行中" : "豆梨 · " + message);
                toggle.setText(ready ? "停止服务" : "启动服务");
                if (ready && !loaded) { loaded = true; web.loadUrl(ORIGIN); }
                if (!ready) loaded = false;
                main.postDelayed(this, 2000);
            });
        }, "douli-health").start();
    }};
    @Override protected void onResume() { super.onResume(); foreground = true; VoiceCallService.listener = voiceListener; main.removeCallbacks(poll); main.post(poll); web.onResume(); voiceListener.onEvent(VoiceCallService.snapshot); }
    @Override protected void onPause() {
        foreground = false; main.removeCallbacks(poll);
        web.evaluateJavascript("window.dispatchEvent(new Event('douli-background'))", null);
        try { if (ScreenShareService.current == null && new JSONObject(VoiceCallService.snapshot).optBoolean("active")) startService(new Intent(this, VoiceCallService.class).setAction("command").putExtra("command", "{\"type\":\"vision\",\"action\":\"stop\"}")); } catch (JSONException ignored) {}
        web.onPause(); super.onPause();
    }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == 1 && microphone != null) {
            boolean granted = foreground && results.length > 0;
            for (int result : results) if (result != PackageManager.PERMISSION_GRANTED) granted = false;
            if (granted) microphone.grant(microphone.getResources()); else microphone.deny();
            microphone = null;
        }
        if (code == 3 && pendingVoice != null) {
            JSONObject request = pendingVoice; pendingVoice = null;
            if (foreground && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) launchVoice(request);
            else voiceListener.onEvent(VoiceCallService.json("type", "error", "message", "麦克风权限未开启，通话没有开始", "nativeStartFailed", true).toString());
        }
        if (code == 4 && pendingRoute != null) {
            JSONObject command = pendingRoute; pendingRoute = null;
            if (foreground && Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED)
                startService(new Intent(this, VoiceCallService.class).setAction("command").putExtra("command", command.toString()));
        }
    }
    private JSONObject voiceCommand(JSONObject request) throws JSONException {
        String action = request.optString("action");
        if ("snapshot".equals(action)) return new JSONObject(VoiceCallService.snapshot);
        if (!foreground) return VoiceCallService.json("error", "请先回到豆梨页面");
        if ("screen_start".equals(action)) {
            if (!VoiceCallService.isActive()) return VoiceCallService.json("error", "请先开始语音通话");
            startActivityForResult(getSystemService(MediaProjectionManager.class).createScreenCaptureIntent(), 80);
            return VoiceCallService.json("pending", true);
        }
        if ("screen_stop".equals(action)) { stopService(new Intent(this, ScreenShareService.class)); return VoiceCallService.json("ok", true); }
        if ("start".equals(action)) {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                pendingVoice = request;
                requestPermissions(Build.VERSION.SDK_INT >= 33 ? new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS} : new String[]{Manifest.permission.RECORD_AUDIO}, 3);
            } else launchVoice(request);
            return VoiceCallService.json("pending", true);
        }
        if ("command".equals(action)) {
            JSONObject command = request.getJSONObject("command");
            if ("end".equals(command.optString("type"))) pendingVoice = null;
            if ("audio_route".equals(command.optString("type")) && "bluetooth".equals(command.optString("route")) && Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                pendingRoute = command; requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT}, 4);
            } else startService(new Intent(this, VoiceCallService.class).setAction("command").putExtra("command", command.toString()));
        }
        return VoiceCallService.json("ok", true);
    }
    private void launchVoice(JSONObject request) {
        if (!foreground) return;
        startForegroundService(new Intent(this, VoiceCallService.class).setAction("start")
            .putExtra("sessionId", request.optString("sessionId")).putExtra("route", request.optString("route", "auto")));
    }
    @Override protected void onDestroy() { if (VoiceCallService.listener == voiceListener) VoiceCallService.listener = null; if(fileSelection!=null) { fileSelection.onReceiveValue(null); fileSelection=null; } main.removeCallbacksAndMessages(null); web.destroy(); super.onDestroy(); }
    @Override protected void onSaveInstanceState(Bundle state) { state.putString("exportUrl",exportUrl); super.onSaveInstanceState(state); }
    @Override protected void onActivityResult(int requestCode,int resultCode,Intent data) {
        super.onActivityResult(requestCode,resultCode,data);
        if (requestCode == 80) {
            if (resultCode == RESULT_OK && data != null && VoiceCallService.isActive())
                startForegroundService(new Intent(this, ScreenShareService.class).putExtra("consent", data).putExtra("result", resultCode));
            return;
        }
        if(requestCode==78) {
            if(fileSelection!=null) { fileSelection.onReceiveValue(resultCode==RESULT_OK && data!=null && data.getData()!=null ? new Uri[]{data.getData()} : null); fileSelection=null; }
            return;
        }
        if (requestCode != 77) return;
        final String url=exportUrl; exportUrl=null;
        if (resultCode != RESULT_OK || data == null || data.getData() == null || url == null) return;
        final Uri destination=data.getData();
        new Thread(() -> {
            try {
                HttpURLConnection connection=(HttpURLConnection)new URL(url).openConnection();
                connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(5000); connection.setReadTimeout(10000);
                try {
                    if (connection.getResponseCode()!=200) throw new IOException("服务没有返回聊天记录");
                    try(InputStream input=connection.getInputStream(); OutputStream output=getContentResolver().openOutputStream(destination,"w")) {
                        if (output==null) throw new IOException("无法写入文件");
                        byte[] bytes=new byte[8192]; int count; while((count=input.read(bytes))!=-1) output.write(bytes,0,count);
                    }
                } finally { connection.disconnect(); }
                main.post(()->Toast.makeText(this,"记录已导出",Toast.LENGTH_LONG).show());
            } catch(Exception error) { main.post(()->Toast.makeText(this,"导出失败，请确认服务仍在运行",Toast.LENGTH_LONG).show()); }
        },"douli-export").start();
    }
    private static byte[] readBytes(InputStream input) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] bytes = new byte[8192];
        int count; while ((count = input.read(bytes)) != -1) out.write(bytes,0,count);
        return out.toByteArray();
    }
    private void welcome() {
        web.loadDataWithBaseURL(ORIGIN,"<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'><body style='margin:0;background:#f6f5f0;color:#354239;font:16px sans-serif;padding:70px 28px;line-height:1.8'><div style='font-size:48px;color:#4a6a58'>d.</div><h1 style='font-weight:500'>把豆梨带在身边</h1><p>点击上方「启动服务」，让手机为 ESP32 提供语音陪伴。</p><p style='color:#7b877c'>手机和 ESP32 连接同一个 Wi-Fi。服务启动后，可在「设备与家居」查看连接地址。</p></body>","text/html","UTF-8",null);
    }
    private void diagnostics() {
        StringBuilder report = new StringBuilder("豆梨 Android 0.4.0\n");
        for (String name : new String[]{"startup-error.txt","data/network.json","data/engine.log"}) {
            File file = new File(getFilesDir(),name);
            if (!file.exists()) continue;
            try (RandomAccessFile input = new RandomAccessFile(file,"r")) {
                input.seek(Math.max(0,input.length()-10000));
                byte[] bytes = new byte[(int)Math.min(10000,input.length())]; input.readFully(bytes);
                report.append("\n").append(name).append("\n").append(new String(bytes,StandardCharsets.UTF_8));
            } catch (Exception error) { report.append("\n读取失败：").append(error.getClass().getSimpleName()); }
        }
        TextView text = new TextView(this); text.setText(report); text.setTextSize(12); text.setTextIsSelectable(true); text.setPadding(24,16,24,16);
        ScrollView scroll = new ScrollView(this); scroll.addView(text);
        new AlertDialog.Builder(this).setTitle("运行诊断").setView(scroll).setPositiveButton("关闭",null).show();
    }
}
