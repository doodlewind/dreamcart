package games.dreamcart

import android.webkit.JavascriptInterface

/**
 * Exposed to the JS shell as `AndroidBridge`. The engine running on the top
 * screen calls these to report its state to the native side. Every method runs
 * on a private WebView JS thread, so they only hand work to [Runtime], which
 * marshals to the main thread.
 */
class WebBridge {
    @JavascriptInterface
    fun games(json: String) = Runtime.reportGames(json)

    @JavascriptInterface
    fun current(file: String) = Runtime.reportCurrent(file)

    @JavascriptInterface
    fun log(msg: String) = Runtime.reportLog(msg)
}
