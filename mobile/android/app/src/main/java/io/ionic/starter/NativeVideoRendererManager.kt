package io.ionic.starter

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.webrtc.EglBase
import org.webrtc.VideoTrack

class NativeVideoRendererManager(
    private val activity: Activity,
    private val webView: WebView,
    private val eglContext: EglBase.Context,
) {

    companion object {
        private const val TAG = "LingoVideoRenderer"
    }

    private var rootContainer: FrameLayout? = null
    private var remoteRenderer: LingoTextureViewRenderer? = null
    private var localRenderer: LingoTextureViewRenderer? = null
    private var subtitleContainer: LinearLayout? = null
    private var subtitleOriginalView: TextView? = null
    private var subtitleLocalTranslationView: TextView? = null
    private var subtitleAiTranslationView: TextView? = null
    private var remoteTrack: VideoTrack? = null
    private var localTrack: VideoTrack? = null

    @Volatile private var released = false

    fun initialize() {
        activity.runOnUiThread {
            if (released) {
                Log.w(TAG, "initialize ignored because renderer manager is released")
                return@runOnUiThread
            }

            if (rootContainer != null) {
                return@runOnUiThread
            }

            val parent = webView.parent as? ViewGroup
            if (parent == null) {
                Log.e(TAG, "Capacitor WebView parent is not a ViewGroup")
                return@runOnUiThread
            }

            val webViewIndex = parent.indexOfChild(webView)
            if (webViewIndex < 0) {
                Log.e(TAG, "Capacitor WebView is not attached to its parent")
                return@runOnUiThread
            }

            val container =
                FrameLayout(activity).apply {
                    setBackgroundColor(Color.TRANSPARENT)
                    clipChildren = false
                    clipToPadding = false
                    isClickable = false
                    isFocusable = false
                    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                }

            /*
             * Native TextureViews must be ABOVE the Capacitor WebView.
             * When they were inserted at webViewIndex, EGL rendered frames
             * successfully but the WebView compositor covered the video.
             */
            parent.addView(
                container,
                webViewIndex + 1,
                ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )

            rootContainer = container

            createRemoteRenderer(container)
            createLocalRenderer(container)
            createSubtitleOverlay(container)

            Log.i(TAG, "Native TextureView video layer initialized above Capacitor WebView")
        }
    }

    private fun createRemoteRenderer(container: FrameLayout) {
        if (remoteRenderer != null) return

        val renderer =
            LingoTextureViewRenderer(activity).apply {
                init(eglContext)
                setMirror(false)
                visibility = View.INVISIBLE
                isClickable = false
                isFocusable = false
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }

        container.addView(
            renderer,
            FrameLayout.LayoutParams(1, 1).apply { gravity = Gravity.TOP or Gravity.START },
        )

        remoteRenderer = renderer
        Log.i(TAG, "Remote TextureView renderer created")
    }

    private fun createLocalRenderer(container: FrameLayout) {
        if (localRenderer != null) return

        val renderer =
            LingoTextureViewRenderer(activity).apply {
                init(eglContext)
                setMirror(true)
                visibility = View.INVISIBLE
                isClickable = false
                isFocusable = false
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                elevation = 1f
            }

        container.addView(
            renderer,
            FrameLayout.LayoutParams(1, 1).apply { gravity = Gravity.TOP or Gravity.START },
        )

        renderer.bringToFront()

        localRenderer = renderer
        Log.i(TAG, "Local TextureView renderer created above remote renderer")
    }


    private fun createSubtitleOverlay(container: FrameLayout) {
        if (subtitleContainer != null) return

        val density = activity.resources.displayMetrics.density
        fun dp(value: Int): Int = (value * density).toInt()

        fun subtitleRow(label: String, color: Int, bold: Boolean = false): TextView =
            TextView(activity).apply {
                setTextColor(color)
                textSize = 15f
                if (bold) typeface = Typeface.DEFAULT_BOLD
                maxLines = 3
                visibility = View.GONE
                tag = label
            }

        val original = subtitleRow("STT", Color.WHITE, bold = true)
        val local = subtitleRow("LOCAL", Color.rgb(86, 214, 255))
        val ai = subtitleRow("AI", Color.rgb(198, 150, 255))

        val card =
            LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                visibility = View.INVISIBLE
                isClickable = false
                isFocusable = false
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                elevation = dp(8).toFloat()
                setPadding(dp(14), dp(10), dp(14), dp(10))
                background =
                    GradientDrawable().apply {
                        shape = GradientDrawable.RECTANGLE
                        cornerRadius = dp(12).toFloat()
                        setColor(Color.argb(210, 8, 17, 28))
                    }

                listOf(original, local, ai).forEachIndexed { index, view ->
                    addView(
                        view,
                        LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT,
                        ).apply { if (index > 0) topMargin = dp(4) },
                    )
                }
            }

        container.addView(
            card,
            FrameLayout.LayoutParams(1, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.TOP or Gravity.START
            },
        )

        subtitleContainer = card
        subtitleOriginalView = original
        subtitleLocalTranslationView = local
        subtitleAiTranslationView = ai
        card.bringToFront()

        Log.i(TAG, "Native subtitle overlay created above video renderers")
    }

    fun setSubtitle(
        originalText: String,
        localTranslation: String,
        aiTranslation: String,
        aiPending: Boolean,
        visible: Boolean,
    ) {
        activity.runOnUiThread {
            if (released) return@runOnUiThread

            val card = subtitleContainer ?: return@runOnUiThread
            val originalView = subtitleOriginalView ?: return@runOnUiThread
            val localView = subtitleLocalTranslationView ?: return@runOnUiThread
            val aiView = subtitleAiTranslationView ?: return@runOnUiThread

            val original = originalText.trim()
            val localText = localTranslation.trim()
            val aiText = aiTranslation.trim()

            originalView.text = if (original.isBlank()) "" else "STT  $original"
            originalView.visibility = if (original.isBlank()) View.GONE else View.VISIBLE

            localView.text = if (localText.isBlank()) "" else "LOCAL  $localText"
            localView.visibility = if (localText.isBlank()) View.GONE else View.VISIBLE

            val aiDisplay =
                when {
                    aiText.isNotBlank() -> "AI  $aiText"
                    aiPending -> "AI  …"
                    else -> ""
                }
            aiView.text = aiDisplay
            aiView.visibility = if (aiDisplay.isBlank()) View.GONE else View.VISIBLE

            card.visibility =
                if (visible && (original.isNotBlank() || localText.isNotBlank() || aiDisplay.isNotBlank())) {
                    View.VISIBLE
                } else {
                    View.INVISIBLE
                }

            card.bringToFront()
        }
    }

    private fun updateSubtitleBounds(
        x: Int,
        y: Int,
        width: Int,
        height: Int,
    ) {
        val card = subtitleContainer ?: return
        if (width <= 0 || height <= 0) return

        val density = activity.resources.displayMetrics.density
        val horizontalInset = (16 * density).toInt()
        val bottomInset = (12 * density).toInt()
        val estimatedHeight = (116 * density).toInt()

        val params =
            card.layoutParams as? FrameLayout.LayoutParams
                ?: FrameLayout.LayoutParams(
                    width - (horizontalInset * 2),
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                )

        params.width = (width - (horizontalInset * 2)).coerceAtLeast(1)
        params.height = ViewGroup.LayoutParams.WRAP_CONTENT
        params.leftMargin = x + horizontalInset
        params.topMargin =
            (y + height - bottomInset - estimatedHeight)
                .coerceAtLeast(y + bottomInset)
        params.gravity = Gravity.TOP or Gravity.START

        card.layoutParams = params
        card.bringToFront()
    }

    fun setLocalTrack(track: VideoTrack?) {
        activity.runOnUiThread {
            if (released) return@runOnUiThread
            val renderer = localRenderer ?: return@runOnUiThread
            if (localTrack === track) return@runOnUiThread

            localTrack?.let { oldTrack ->
                try {
                    oldTrack.removeSink(renderer)
                } catch (e: Exception) {
                    Log.w(TAG, "Failed removing old local video sink", e)
                }
            }

            localTrack = track

            track?.let { newTrack ->
                try {
                    newTrack.addSink(renderer)
                    Log.i(TAG, "Local VideoTrack attached to TextureView renderer")
                } catch (e: Exception) {
                    Log.e(TAG, "Failed attaching local VideoTrack", e)
                }
            }
        }
    }

    fun setRemoteTrack(track: VideoTrack?) {
        activity.runOnUiThread {
            if (released) return@runOnUiThread
            val renderer = remoteRenderer ?: return@runOnUiThread
            if (remoteTrack === track) return@runOnUiThread

            remoteTrack?.let { oldTrack ->
                try {
                    oldTrack.removeSink(renderer)
                } catch (e: Exception) {
                    Log.w(TAG, "Failed removing old remote video sink", e)
                }
            }

            remoteTrack = track

            track?.let { newTrack ->
                try {
                    newTrack.addSink(renderer)
                    Log.i(TAG, "Remote VideoTrack attached to TextureView renderer")
                } catch (e: Exception) {
                    Log.e(TAG, "Failed attaching remote VideoTrack", e)
                }
            }
        }
    }

    fun setRemoteBounds(x: Int, y: Int, width: Int, height: Int, visible: Boolean) {
        activity.runOnUiThread {
            if (released) return@runOnUiThread
            val renderer = remoteRenderer ?: return@runOnUiThread

            if (!visible || width <= 0 || height <= 0) {
                renderer.visibility = View.INVISIBLE
                return@runOnUiThread
            }

            val params =
                renderer.layoutParams as? FrameLayout.LayoutParams
                    ?: FrameLayout.LayoutParams(width, height)

            params.width = width
            params.height = height
            params.leftMargin = x
            params.topMargin = y
            params.gravity = Gravity.TOP or Gravity.START

            renderer.layoutParams = params
            renderer.visibility = View.VISIBLE

            // Remote bounds may be refreshed after the local renderer was added.
            // Keep the local self-preview above the remote video.
            localRenderer?.bringToFront()
            updateSubtitleBounds(x, y, width, height)
            subtitleContainer?.bringToFront()

            Log.d(TAG, "Remote bounds x=$x y=$y w=$width h=$height visible=$visible")
        }
    }

    fun setLocalBounds(x: Int, y: Int, width: Int, height: Int, visible: Boolean) {
        activity.runOnUiThread {
            if (released) return@runOnUiThread
            val renderer = localRenderer ?: return@runOnUiThread

            if (!visible || width <= 0 || height <= 0) {
                renderer.visibility = View.INVISIBLE
                return@runOnUiThread
            }

            val params =
                renderer.layoutParams as? FrameLayout.LayoutParams
                    ?: FrameLayout.LayoutParams(width, height)

            params.width = width
            params.height = height
            params.leftMargin = x
            params.topMargin = y
            params.gravity = Gravity.TOP or Gravity.START

            renderer.layoutParams = params
            renderer.visibility = View.VISIBLE
            subtitleContainer?.bringToFront()

            Log.d(TAG, "Local bounds x=$x y=$y w=$width h=$height visible=$visible")
        }
    }

    fun hide() {
        activity.runOnUiThread {
            if (released) return@runOnUiThread
            remoteRenderer?.visibility = View.INVISIBLE
            localRenderer?.visibility = View.INVISIBLE
            subtitleContainer?.visibility = View.INVISIBLE
        }
    }

    fun release() {
        if (released) return
        released = true

        activity.runOnUiThread {
            remoteRenderer?.let { renderer ->
                remoteTrack?.let { track ->
                    try {
                        track.removeSink(renderer)
                    } catch (e: Exception) {
                        Log.w(TAG, "Failed removing remote sink during release", e)
                    }
                }

                try {
                    renderer.release()
                } catch (e: Exception) {
                    Log.w(TAG, "Remote renderer release failed", e)
                }
            }

            localRenderer?.let { renderer ->
                localTrack?.let { track ->
                    try {
                        track.removeSink(renderer)
                    } catch (e: Exception) {
                        Log.w(TAG, "Failed removing local sink during release", e)
                    }
                }

                try {
                    renderer.release()
                } catch (e: Exception) {
                    Log.w(TAG, "Local renderer release failed", e)
                }
            }

            remoteTrack = null
            localTrack = null
            remoteRenderer = null
            localRenderer = null
            subtitleOriginalView = null
            subtitleLocalTranslationView = null
            subtitleAiTranslationView = null
            subtitleContainer = null

            rootContainer?.let { container ->
                try {
                    (container.parent as? ViewGroup)?.removeView(container)
                } catch (e: Exception) {
                    Log.w(TAG, "Renderer container removal failed", e)
                }
            }

            rootContainer = null
            Log.i(TAG, "Native TextureView video renderer released")
        }
    }
}
