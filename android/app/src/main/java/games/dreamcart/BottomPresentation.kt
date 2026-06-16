package games.dreamcart

import android.app.Presentation
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.util.TypedValue
import android.view.Display
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The game library shown on the device's second internal display (the bottom
 * touch screen, 3DS-style). It is *only* a switcher: tap a title to load it on
 * the top screen. There is deliberately no virtual gamepad — the console's
 * physical D-pad / ABXY buttons play the game (see [MainActivity]).
 *
 * The window is made non-focusable so it can never capture the physical keys;
 * those always flow to the top Activity and into the running game. Touch still
 * works for the list.
 */
class BottomPresentation(outerContext: Context, display: Display) :
    Presentation(outerContext, display) {

    private lateinit var gameList: LinearLayout
    private lateinit var nowPlaying: TextView
    private lateinit var logView: TextView

    private val rowByFile = HashMap<String, Button>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Never take key-input focus: the D-pad/ABXY must reach the top game,
        // not navigate this menu. Touch events still reach the list.
        window?.addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)

        setContentView(R.layout.bottom_screen)
        gameList = findViewById(R.id.game_list)
        nowPlaying = findViewById(R.id.now_playing)
        logView = findViewById(R.id.log)

        Runtime.onGamesChanged = { rebuildList() }
        Runtime.onCurrentChanged = { highlightCurrent() }
        Runtime.onLog = { appendLog(it) }

        rebuildList()
        highlightCurrent()
    }

    /** Build the library as a two-column grid of tappable, non-focusable rows. */
    private fun rebuildList() {
        gameList.removeAllViews()
        rowByFile.clear()
        var row: LinearLayout? = null
        Runtime.games.forEachIndexed { i, g ->
            if (i % 2 == 0) {
                row = LinearLayout(context).apply {
                    orientation = LinearLayout.HORIZONTAL
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    )
                }
                gameList.addView(row)
            }
            val b = Button(context).apply {
                text = g.title
                isAllCaps = false
                textSize = 16f
                isFocusable = false          // touch only — no D-pad navigation
                isFocusableInTouchMode = false
                gravity = Gravity.START or Gravity.CENTER_VERTICAL
                setPadding(dp(14), dp(12), dp(14), dp(12))
                layoutParams = LinearLayout.LayoutParams(
                    0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f,
                ).apply { setMargins(dp(4), dp(4), dp(4), dp(4)) }
                setOnClickListener { Runtime.play(g.file) }
            }
            rowByFile[g.file] = b
            row!!.addView(b)
        }
        highlightCurrent()
        if (BuildConfig.DEBUG) logButtonRects()
    }

    private fun highlightCurrent() {
        val cur = Runtime.current
        for ((file, b) in rowByFile) {
            val on = file == cur
            b.setBackgroundColor(Color.parseColor(if (on) "#5EE08A" else "#222736"))
            b.setTextColor(Color.parseColor(if (on) "#06210F" else "#E6E8EE"))
        }
        val title = Runtime.games.firstOrNull { it.file == cur }?.title
        nowPlaying.text = if (title != null) "▶ $title" else context.getString(R.string.loading)
    }

    private fun appendLog(msg: String) {
        val lines = (logView.text?.toString().orEmpty() + msg + "\n").split("\n")
        logView.text = lines.takeLast(2).joinToString("\n")
    }

    private fun dp(v: Int): Int = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), context.resources.displayMetrics
    ).toInt()

    /** Debug aid: log each game button's centre (display coords) for e2e taps. */
    private fun logButtonRects() {
        gameList.post {
            val loc = IntArray(2)
            for ((file, b) in rowByFile) {
                b.getLocationOnScreen(loc)
                Log.i("DreamCart", "GAMEBTN $file tap=${loc[0] + b.width / 2},${loc[1] + b.height / 2}")
            }
        }
    }

    override fun onStop() {
        if (Runtime.onGamesChanged != null) Runtime.onGamesChanged = null
        if (Runtime.onCurrentChanged != null) Runtime.onCurrentChanged = null
        if (Runtime.onLog != null) Runtime.onLog = null
        super.onStop()
    }
}
