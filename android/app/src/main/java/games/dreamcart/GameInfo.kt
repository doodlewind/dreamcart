package games.dreamcart

/** One playable JS game, as reported by the engine running in the WebView. */
data class GameInfo(
    val file: String,
    val title: String,
    val controls: String,
    val kind: String,
)
