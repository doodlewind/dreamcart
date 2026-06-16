package games.dreamcart

import android.annotation.SuppressLint
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Display
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Top screen (default display). Hosts a full-screen WebView running the exact
 * same isomorphic JS engine (web/engine.js) the Web/PSP/3DS builds use, so games
 * run unchanged. The console's physical buttons play the game; the second
 * internal display shows the native [BottomPresentation] library.
 *
 * Both screens share the Activity lifecycle: the bottom Presentation is shown in
 * [onStart] and dismissed in [onStop], so backgrounding the app (swipe-up home)
 * clears both screens, and returning restores both.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private var bottom: BottomPresentation? = null

    // Physical handheld buttons -> canonical DreamCart button bits.
    private val keyMap: Map<Int, Int> = mapOf(
        KeyEvent.KEYCODE_DPAD_UP to Runtime.Btn.UP,
        KeyEvent.KEYCODE_DPAD_DOWN to Runtime.Btn.DOWN,
        KeyEvent.KEYCODE_DPAD_LEFT to Runtime.Btn.LEFT,
        KeyEvent.KEYCODE_DPAD_RIGHT to Runtime.Btn.RIGHT,
        KeyEvent.KEYCODE_BUTTON_A to Runtime.Btn.CROSS,
        KeyEvent.KEYCODE_BUTTON_B to Runtime.Btn.CIRCLE,
        KeyEvent.KEYCODE_BUTTON_X to Runtime.Btn.SQUARE,
        KeyEvent.KEYCODE_BUTTON_Y to Runtime.Btn.TRIANGLE,
        KeyEvent.KEYCODE_BUTTON_START to Runtime.Btn.START,
        KeyEvent.KEYCODE_ENTER to Runtime.Btn.START,
        KeyEvent.KEYCODE_BUTTON_SELECT to Runtime.Btn.SELECT,
    )

    // Shoulder buttons cycle the library (the DreamCart contract has no L/R, so
    // games never read them — free to repurpose for switching games).
    private val switchKeys: Map<Int, Int> = mapOf(
        KeyEvent.KEYCODE_BUTTON_L1 to -1,
        KeyEvent.KEYCODE_BUTTON_R1 to 1,
    )

    // Last D-pad-as-hat-axis state, so we can emit press/release transitions.
    private var hatX = 0
    private var hatY = 0

    /** Debug hook: `adb shell am broadcast -a games.dreamcart.PLAY --es game raw-pong.js` */
    private val playReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            val file = intent.getStringExtra("game")
            val index = intent.getIntExtra("index", -1)
            val nav = intent.getStringExtra("nav")
            when {
                file != null -> Runtime.play(file)
                index >= 0 -> Runtime.playIndex(index)
                nav == "next" -> Runtime.playRelative(1)
                nav == "prev" -> Runtime.playRelative(-1)
            }
            Log.i("DreamCart", "PLAY broadcast game=$file index=$index nav=$nav")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        web = WebView(this).apply {
            setBackgroundColor(Color.BLACK)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = true
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    if (BuildConfig.DEBUG) {
                        view.evaluateJavascript(
                            "window.DC_DEBUG=true;" +
                                "window.DreamCart&&DreamCart._startDebugHeartbeat&&DreamCart._startDebugHeartbeat();",
                            null,
                        )
                    }
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                    Log.i("DreamCart", "[web] ${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                    return true
                }
            }
            addJavascriptInterface(WebBridge(), "AndroidBridge")
        }
        Runtime.webView = web
        setContentView(web)
        web.loadUrl("file:///android_asset/index.html")

        registerPlayReceiver()
    }

    override fun onStart() {
        super.onStart()
        showBottomScreen()
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
    }

    /** Backgrounding the top screen must also clear the bottom screen. */
    override fun onStop() {
        bottom?.dismiss()
        bottom = null
        super.onStop()
    }

    /** Find the secondary internal display and show the native UI there. */
    private fun showBottomScreen() {
        if (bottom?.isShowing == true) return
        val dm = getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        val target = dm.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION).firstOrNull()
            ?: dm.displays.firstOrNull { it.displayId != Display.DEFAULT_DISPLAY }
        if (target == null) {
            Log.w("DreamCart", "no secondary display found; bottom UI unavailable")
            return
        }
        Log.i("DreamCart", "bottom UI -> display ${target.displayId} (${target.name})")
        bottom = BottomPresentation(this, target).also {
            it.setOnDismissListener { bottom = null }
            it.show()
        }
    }

    private fun hideSystemBars() {
        @Suppress("DEPRECATION")
        web.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            )
    }

    private fun registerPlayReceiver() {
        val filter = IntentFilter("games.dreamcart.PLAY")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(playReceiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(playReceiver, filter)
        }
    }

    // ---- physical input -> game ------------------------------------------
    // Intercepted at the window entry point so the WebView never eats game keys,
    // and (with the bottom Presentation non-focusable) so the D-pad always
    // reaches the game instead of navigating the menu.

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val code = event.keyCode
        if (BuildConfig.DEBUG && event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            Log.i("DreamCart", "KEY ${KeyEvent.keyCodeToString(code)}($code)")
        }

        keyMap[code]?.let { bit ->
            when (event.action) {
                KeyEvent.ACTION_DOWN -> if (event.repeatCount == 0) Runtime.press(bit, true)
                KeyEvent.ACTION_UP -> Runtime.press(bit, false)
            }
            return true
        }
        switchKeys[code]?.let { delta ->
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                Runtime.playRelative(delta)
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
        val isJoystick = event.source and InputDevice.SOURCE_JOYSTICK == InputDevice.SOURCE_JOYSTICK
        if (isJoystick && event.action == MotionEvent.ACTION_MOVE) {
            if (BuildConfig.DEBUG) {
                val hx = event.getAxisValue(MotionEvent.AXIS_HAT_X)
                val hy = event.getAxisValue(MotionEvent.AXIS_HAT_Y)
                if (hx != 0f || hy != 0f) Log.i("DreamCart", "HAT x=$hx y=$hy")
            }
            // D-pad reported as a hat axis (the Odin Controller exposes both).
            applyAxis(event.getAxisValue(MotionEvent.AXIS_HAT_X), hatX, Runtime.Btn.LEFT, Runtime.Btn.RIGHT) { hatX = it }
            applyAxis(event.getAxisValue(MotionEvent.AXIS_HAT_Y), hatY, Runtime.Btn.UP, Runtime.Btn.DOWN) { hatY = it }
            return true
        }
        return super.dispatchGenericMotionEvent(event)
    }

    /** Translate an axis (-1/0/1) into press/release of its two direction bits. */
    private inline fun applyAxis(value: Float, prev: Int, negBit: Int, posBit: Int, store: (Int) -> Unit) {
        val now = when {
            value <= -0.5f -> -1
            value >= 0.5f -> 1
            else -> 0
        }
        if (now == prev) return
        // release whatever direction was held, then press the new one
        if (prev < 0) Runtime.press(negBit, false)
        if (prev > 0) Runtime.press(posBit, false)
        if (now < 0) Runtime.press(negBit, true)
        if (now > 0) Runtime.press(posBit, true)
        store(now)
    }

    override fun onDestroy() {
        try {
            unregisterReceiver(playReceiver)
        } catch (_: Exception) {
        }
        bottom?.dismiss()
        bottom = null
        if (Runtime.webView === web) Runtime.webView = null
        web.destroy()
        super.onDestroy()
    }
}
