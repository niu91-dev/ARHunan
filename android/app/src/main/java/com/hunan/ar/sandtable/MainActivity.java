package com.hunan.ar.sandtable;

import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.webkit.WebViewAssetLoader;

public class MainActivity extends AppCompatActivity {
    private WebView webView;
    private WebViewAssetLoader assetLoader;
    private static final int CAMERA_PERMISSION_REQUEST = 1001;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        installCrashHandler();
        writeLog("onCreate start, sdk=" + Build.VERSION.SDK_INT, null);

        // 保持屏幕常亮
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        try {
            initWebView();
        } catch (Throwable t) {
            writeLog("initWebView failed", t);
            showFatalScreen("WebView 初始化失败\n\n" + t);
        }
    }

    private void initWebView() {
        hideSystemUI();

        webView = new WebView(this);
        WebView.setWebContentsDebuggingEnabled(true);
        setContentView(webView);

        // 建立离线虚拟 HTTPS 资产映射（确保满足 camera 和传感器的 secure context 要求）
        assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                writeLog("onReceivedError " + request.getUrl() + " -> " + error.getDescription(), null);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // 网页请求相机或音频权限时，直接自动批准放行
                runOnUiThread(() -> {
                    try {
                        request.grant(request.getResources());
                    } catch (Throwable t) {
                        writeLog("grant permission failed", t);
                    }
                });
            }
        });

        // 检查并请求系统级相机权限
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_REQUEST);
        } else {
            loadArDemo();
        }
    }

    private void loadArDemo() {
        try {
            webView.loadUrl("https://appassets.androidplatform.net/assets/ar-holo-demo.html");
        } catch (Throwable t) {
            writeLog("loadUrl failed", t);
            showFatalScreen("加载页面失败\n\n" + t);
        }
    }

    /** 把未捕获异常写入应用私有目录，便于现场排查 */
    private void installCrashHandler() {
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
            writeLog("UNCAUGHT on " + thread.getName(), throwable);
            if (previous != null) {
                previous.uncaughtException(thread, throwable);
            }
        });
    }

    private void writeLog(String tag, Throwable t) {
        Log.e("HunanAR", tag, t);
        try {
            String text;
            if (t != null) {
                java.io.StringWriter sw = new java.io.StringWriter();
                t.printStackTrace(new java.io.PrintWriter(sw));
                text = tag + "\n" + sw.toString();
            } else {
                text = tag;
            }
            java.io.File dir = getExternalFilesDir(null);
            if (dir == null) {
                dir = getFilesDir();
            }
            java.io.File file = new java.io.File(dir, "crash.log");
            java.io.FileOutputStream out = new java.io.FileOutputStream(file, true);
            String stamp = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US)
                    .format(new java.util.Date());
            out.write((stamp + "  " + text + "\n\n").getBytes("UTF-8"));
            out.close();
        } catch (Throwable ignored) {
            // 写日志本身失败时不再抛异常
        }
    }

    private void showFatalScreen(String message) {
        TextView tv = new TextView(this);
        tv.setText(message + "\n\n崩溃日志：" + getLogPath());
        tv.setTextColor(Color.WHITE);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        tv.setGravity(Gravity.CENTER);
        tv.setPadding(48, 48, 48, 48);
        tv.setBackgroundColor(Color.parseColor("#1B2220"));
        setContentView(tv);
    }

    private String getLogPath() {
        java.io.File dir = getExternalFilesDir(null);
        if (dir == null) {
            dir = getFilesDir();
        }
        return new java.io.File(dir, "crash.log").getAbsolutePath();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CAMERA_PERMISSION_REQUEST && grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            loadArDemo();
        } else {
            loadArDemo();
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideSystemUI();
        }
    }

    private void hideSystemUI() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            final WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
            );
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
