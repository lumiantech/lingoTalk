package io.ionic.starter

import android.content.Context
import android.graphics.SurfaceTexture
import android.util.AttributeSet
import android.util.Log
import android.view.TextureView
import org.webrtc.EglBase
import org.webrtc.EglRenderer
import org.webrtc.GlRectDrawer
import org.webrtc.VideoFrame
import org.webrtc.VideoSink

class LingoTextureViewRenderer
@JvmOverloads
constructor(context: Context, attrs: AttributeSet? = null) :
    TextureView(context, attrs), VideoSink, TextureView.SurfaceTextureListener {

    companion object {
        private const val TAG = "LingoTextureRenderer"
    }

    private val eglRenderer = EglRenderer("LingoTextureView")

    @Volatile private var initialized = false

    @Volatile private var released = false

    init {
        surfaceTextureListener = this
        isOpaque = true
    }

    fun init(sharedContext: EglBase.Context) {
        check(!released) { "Renderer is already released" }

        if (initialized) {
            return
        }

        eglRenderer.init(sharedContext, EglBase.CONFIG_PLAIN, GlRectDrawer())

        initialized = true

        if (isAvailable) {
            surfaceTexture?.let { texture ->
                eglRenderer.createEglSurface(texture)
                updateAspectRatio(width, height)
            }
        }

        Log.i(TAG, "TextureView EGL renderer initialized")
    }

    fun setMirror(mirror: Boolean) {
        eglRenderer.setMirror(mirror)
    }

    override fun onFrame(frame: VideoFrame) {
        if (!initialized || released) {
            return
        }

        eglRenderer.onFrame(frame)
    }

    override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
        if (!initialized || released) {
            return
        }

        eglRenderer.createEglSurface(surface)
        updateAspectRatio(width, height)

        Log.i(TAG, "SurfaceTexture available: ${width}x${height}")
    }

    override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
        if (!initialized || released) {
            return
        }

        updateAspectRatio(width, height)
    }

    override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
        if (initialized && !released) {
            eglRenderer.releaseEglSurface { Log.i(TAG, "EGL surface released") }
        }

        return true
    }

    override fun onSurfaceTextureUpdated(surface: SurfaceTexture) = Unit

    private fun updateAspectRatio(width: Int, height: Int) {
        if (width <= 0 || height <= 0) {
            return
        }

        eglRenderer.setLayoutAspectRatio(width.toFloat() / height.toFloat())
    }

    fun release() {
        if (released) {
            return
        }

        released = true

        if (initialized) {
            try {
                eglRenderer.release()
            } catch (e: Exception) {
                Log.w(TAG, "EglRenderer release failed", e)
            }
        }

        initialized = false
        surfaceTextureListener = null

        Log.i(TAG, "TextureView renderer released")
    }
}
