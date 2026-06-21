package games.dreamcart

import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import org.json.JSONArray

/**
 * Central hub between the native Android UI (bottom screen) and the JS engine
 * running in the WebView (top screen).
 *
 * The bottom screen calls [play] / [press]; those are turned into JS and run in
 * the WebView via [WebView.evaluateJavascript]. In the other direction the JS
 * shell reports its game list / current game / logs back through [WebBridge],
 * which forwards to the report* methods here. Listeners (the Presentation) are
 * notified on the main thread so they can safely touch their views.
 *
 * Button bits mirror the canonical contract in framework/src/input.ts and
 * web/engine.js (BTN) — the same bitmask every DreamCart platform uses.
 */
object Runtime {
    private const val TAG = "DreamCart"
    private val main = Handler(Looper.getMainLooper())

    /** Canonical button bits — identical to web/engine.js BTN. */
    object Btn {
        const val SELECT = 0x01
        const val START = 0x08
        const val UP = 0x10
        const val RIGHT = 0x20
        const val DOWN = 0x40
        const val LEFT = 0x80
        const val LTRIGGER = 0x100
        const val RTRIGGER = 0x200
        const val TRIANGLE = 0x1000
        const val CIRCLE = 0x2000
        const val CROSS = 0x4000
        const val SQUARE = 0x8000
    }

    @Volatile
    var webView: WebView? = null

    val games = ArrayList<GameInfo>()
    var current: String? = null
        private set

    /** UI listeners (set by the bottom Presentation). Always invoked on main. */
    var onGamesChanged: (() -> Unit)? = null
    var onCurrentChanged: (() -> Unit)? = null
    var onLog: ((String) -> Unit)? = null

    /** Drop the bottom-screen listeners. Called when its Presentation is
     *  dismissed (the reliable teardown signal) so the singleton never retains
     *  a dead Presentation/Activity. */
    fun clearUiListeners() {
        onGamesChanged = null
        onCurrentChanged = null
        onLog = null
    }

    private fun eval(js: String) = main.post {
        webView?.evaluateJavascript(js, null)
    }

    // ---- commands: native -> JS ------------------------------------------

    /** Hold (down=true) or release (down=false) a controller button. */
    fun press(bit: Int, down: Boolean) =
        eval("window.DreamCart && DreamCart.press($bit, $down);")

    /** Release every held button — used when the top screen loses focus so a
     *  button held at that moment can't get stuck down in the game. */
    fun releaseAllButtons() =
        eval("window.DreamCart && DreamCart.releaseAll();")

    /** Switch the running game to [file] (a key in the games manifest). */
    fun play(file: String) =
        eval("window.DreamCart && DreamCart.play(${quote(file)});")

    fun playIndex(index: Int) {
        val g = games.getOrNull(index) ?: return
        play(g.file)
    }

    fun playRelative(delta: Int) {
        if (games.isEmpty()) return
        val cur = games.indexOfFirst { it.file == current }.let { if (it < 0) 0 else it }
        val next = ((cur + delta) % games.size + games.size) % games.size
        play(games[next].file)
    }

    // ---- reports: JS -> native (called from the WebBridge thread) --------

    fun reportGames(json: String) {
        val parsed = ArrayList<GameInfo>()
        try {
            val arr = JSONArray(json)
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                parsed.add(
                    GameInfo(
                        file = o.getString("file"),
                        title = o.optString("title", o.getString("file")),
                        controls = o.optString("controls", ""),
                        kind = o.optString("kind", "raw"),
                    )
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "bad games json", e)
            return
        }
        main.post {
            games.clear()
            games.addAll(parsed)
            Log.i(TAG, "games reported: ${games.size} -> ${games.joinToString { it.file }}")
            onGamesChanged?.invoke()
        }
    }

    fun reportCurrent(file: String) = main.post {
        current = file
        Log.i(TAG, "current game -> $file")
        onCurrentChanged?.invoke()
    }

    fun reportLog(msg: String) {
        Log.i(TAG, "[game] $msg")
        main.post { onLog?.invoke(msg) }
    }

    private fun quote(s: String): String =
        "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}
