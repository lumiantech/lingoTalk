package io.ionic.starter

import android.Manifest
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.webrtc.IceCandidate
import org.webrtc.PeerConnection
import org.webrtc.SessionDescription
import org.webrtc.VideoTrack

@CapacitorPlugin(name = "NativeWebRtc")
class NativeWebRtcPlugin : Plugin(), NativeWebRtc.Listener {

    companion object {

        private const val TAG = "LingoWebRtcPlugin"
    }

    private var engine: NativeWebRtc? = null

    private var rendererManager: NativeVideoRendererManager? = null

    /*
     * Remote track is kept here because the next step
     * will connect it to our Android video renderer.
     */
    private var remoteVideoTrack: VideoTrack? = null

    /*
     * =========================================================
     * LOAD
     * =========================================================
     */

    override fun load() {

        Log.i(TAG, "NativeWebRtcPlugin loaded")
    }

    /*
     * =========================================================
     * INITIALIZE
     * =========================================================
     */

    @PluginMethod
    fun setVideoLayout(call: PluginCall) {

        val renderer = rendererManager

        if (renderer == null) {

            call.reject("Native video renderer is not initialized")

            return
        }

        try {

            /*
             * IMPORTANT:
             *
             * Angular getBoundingClientRect() gives CSS pixels.
             *
             * Capacitor WebView reports coordinates in CSS px,
             * while Android View layout uses physical px.
             *
             * Angular therefore sends devicePixelRatio and we
             * convert everything here.
             */

            val pixelRatio = call.getDouble("pixelRatio") ?: 1.0

            // --------------------------------------------------------
            // REMOTE
            // --------------------------------------------------------

            val remote = call.getObject("remote")

            if (remote != null) {

                val x = ((remote.getDouble("x") ?: 0.0) * pixelRatio).toInt()

                val y = ((remote.getDouble("y") ?: 0.0) * pixelRatio).toInt()

                val width = ((remote.getDouble("width") ?: 0.0) * pixelRatio).toInt()

                val height = ((remote.getDouble("height") ?: 0.0) * pixelRatio).toInt()

                val visible = remote.getBool("visible") ?: true

                renderer.setRemoteBounds(
                    x = x,
                    y = y,
                    width = width,
                    height = height,
                    visible = visible,
                )
            }

            // --------------------------------------------------------
            // LOCAL
            // --------------------------------------------------------

            val local = call.getObject("local")

            if (local != null) {

                val x = ((local.getDouble("x") ?: 0.0) * pixelRatio).toInt()

                val y = ((local.getDouble("y") ?: 0.0) * pixelRatio).toInt()

                val width = ((local.getDouble("width") ?: 0.0) * pixelRatio).toInt()

                val height = ((local.getDouble("height") ?: 0.0) * pixelRatio).toInt()

                val visible = local.getBool("visible") ?: true

                renderer.setLocalBounds(
                    x = x,
                    y = y,
                    width = width,
                    height = height,
                    visible = visible,
                )
            }

            call.resolve()
        } catch (e: Exception) {

            Log.e(TAG, "setVideoLayout failed", e)

            call.reject(e.message ?: "Failed to update native video layout", e)
        }
    }

    @PluginMethod
    fun hideVideoRenderers(call: PluginCall) {

        rendererManager?.hide()

        call.resolve()
    }

    @PluginMethod
    fun setSubtitleOverlay(call: PluginCall) {

        val renderer = rendererManager

        if (renderer == null) {
            call.reject("Native video renderer is not initialized")
            return
        }

        try {
            renderer.setSubtitle(
                originalText = call.getString("originalText") ?: "",
                localTranslation = call.getString("localTranslation") ?: "",
                aiTranslation = call.getString("aiTranslation") ?: "",
                aiPending = call.getBoolean("aiPending") ?: false,
                visible = call.getBoolean("visible") ?: true,
            )

            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "setSubtitleOverlay failed", e)
            call.reject(e.message ?: "Failed to update native subtitle overlay", e)
        }
    }

    @PluginMethod
    fun initialize(call: PluginCall) {

        activity.runOnUiThread {
            try {

                ensurePermissions()

                if (engine == null) {

                    val newEngine =
                        NativeWebRtc(context = context.applicationContext, listener = this)

                    newEngine.initialize()

                    engine = newEngine

                    val renderer =
                        NativeVideoRendererManager(
                            activity = activity,
                            webView = bridge.webView,
                            eglContext = newEngine.getEglContext(),
                        )

                    renderer.initialize()

                    renderer.setLocalTrack(newEngine.getLocalVideoTrack())

                    rendererManager = renderer
                }

                call.resolve(JSObject().apply { put("initialized", true) })
            } catch (e: Exception) {

                Log.e(TAG, "initialize failed", e)

                call.reject(e.message ?: "Native WebRTC initialization failed", e)
            }
        }
    }

    /*
     * =========================================================
     * CREATE PEER CONNECTION
     * =========================================================
     */

    @PluginMethod
    fun createPeerConnection(call: PluginCall) {

        activity.runOnUiThread {
            try {

                val currentEngine = requireEngine()

                currentEngine.createPeerConnection()

                call.resolve(JSObject().apply { put("created", true) })
            } catch (e: Exception) {

                Log.e(TAG, "createPeerConnection failed", e)

                call.reject(e.message ?: "Failed to create PeerConnection", e)
            }
        }
    }

    /*
     * =========================================================
     * CREATE OFFER
     * =========================================================
     */

    @PluginMethod
    fun createOffer(call: PluginCall) {

        try {

            requireEngine().createOffer { result ->
                result.fold(
                    onSuccess = { description ->
                        call.resolve(sessionDescriptionToJs(description))
                    },
                    onFailure = { error ->
                        Log.e(TAG, "createOffer failed", error)

                        call.reject(error.message ?: "Failed to create offer", error as? Exception ?: Exception(error))
                    },
                )
            }
        } catch (e: Exception) {

            call.reject(e.message ?: "Failed to create offer", e)
        }
    }

    /*
     * =========================================================
     * ACCEPT OFFER
     * =========================================================
     */

    @PluginMethod
    fun acceptOffer(call: PluginCall) {

        val sdp = call.getString("sdp")

        if (sdp.isNullOrBlank()) {

            call.reject("Missing offer SDP")

            return
        }

        try {

            requireEngine().acceptOffer(sdp) { result ->
                result.fold(
                    onSuccess = { description ->
                        call.resolve(sessionDescriptionToJs(description))
                    },
                    onFailure = { error ->
                        Log.e(TAG, "acceptOffer failed", error)

                        call.reject(error.message ?: "Failed to accept offer", error as? Exception ?: Exception(error))
                    },
                )
            }
        } catch (e: Exception) {

            call.reject(e.message ?: "Failed to accept offer", e)
        }
    }

    /*
     * =========================================================
     * ACCEPT ANSWER
     * =========================================================
     */

    @PluginMethod
    fun acceptAnswer(call: PluginCall) {

        val sdp = call.getString("sdp")

        if (sdp.isNullOrBlank()) {

            call.reject("Missing answer SDP")

            return
        }

        try {

            requireEngine().acceptAnswer(sdp) { result ->
                result.fold(
                    onSuccess = { call.resolve() },
                    onFailure = { error ->
                        Log.e(TAG, "acceptAnswer failed", error)

                        call.reject(error.message ?: "Failed to accept answer", error as? Exception ?: Exception(error))
                    },
                )
            }
        } catch (e: Exception) {

            call.reject(e.message ?: "Failed to accept answer", e)
        }
    }

    /*
     * =========================================================
     * ICE
     * =========================================================
     */

    @PluginMethod
    fun addIceCandidate(call: PluginCall) {

        val candidate = call.getString("candidate")

        if (candidate.isNullOrBlank()) {

            call.reject("Missing ICE candidate")

            return
        }

        val sdpMid = call.getString("sdpMid")

        val sdpMLineIndex = call.getInt("sdpMLineIndex")

        if (sdpMLineIndex == null) {

            call.reject("Missing sdpMLineIndex")

            return
        }

        try {

            val added =
                requireEngine()
                    .addIceCandidate(
                        sdpMid = sdpMid,
                        sdpMLineIndex = sdpMLineIndex,
                        candidate = candidate,
                    )

            if (!added) {

                call.reject("WebRTC rejected ICE candidate")

                return
            }

            call.resolve()
        } catch (e: Exception) {

            call.reject(e.message ?: "Failed to add ICE candidate", e)
        }
    }

    /*
     * =========================================================
     * MICROPHONE
     * =========================================================
     */

    @PluginMethod
    fun setMicrophoneEnabled(call: PluginCall) {

        val enabled = call.getBoolean("enabled")

        if (enabled == null) {

            call.reject("Missing enabled")

            return
        }

        try {

            requireEngine().setMicrophoneEnabled(enabled)

            call.resolve()
        } catch (e: Exception) {

            call.reject(e.message ?: "Failed to change microphone state", e)
        }
    }

    /*
     * =========================================================
     * CAMERA ENABLE
     * =========================================================
     */

    @PluginMethod
    fun setCameraEnabled(call: PluginCall) {

        val enabled = call.getBoolean("enabled")

        if (enabled == null) {

            call.reject("Missing enabled")

            return
        }

        try {

            requireEngine().setCameraEnabled(enabled)

            call.resolve()
        } catch (e: Exception) {

            call.reject(e.message ?: "Failed to change camera state", e)
        }
    }

    /*
     * =========================================================
     * SWITCH CAMERA
     * =========================================================
     */

    @PluginMethod
    fun switchCamera(call: PluginCall) {

        try {

            requireEngine().switchCamera { result ->
                result.fold(
                    onSuccess = { call.resolve() },
                    onFailure = { error ->
                        call.reject(error.message ?: "Failed to switch camera", error as? Exception ?: Exception(error))
                    },
                )
            }
        } catch (e: Exception) {

            call.reject(e.message ?: "Failed to switch camera", e)
        }
    }

    /*
     * =========================================================
     * CLOSE CALL
     * =========================================================
     */

    @PluginMethod
    fun closePeerConnection(call: PluginCall) {

        try {

            rendererManager?.setRemoteTrack(null)
            remoteVideoTrack = null

            engine?.closePeerConnection()

            call.resolve()
        } catch (e: Exception) {

            call.reject(e.message ?: "Failed to close PeerConnection", e)
        }
    }

    /*
     * =========================================================
     * FULL RELEASE
     * =========================================================
     */

    @PluginMethod
    fun release(call: PluginCall) {

        try {

            remoteVideoTrack = null

            rendererManager?.release()

            rendererManager = null

            engine?.release()

            engine = null

            call.resolve()
        } catch (e: Exception) {

            Log.e(TAG, "release failed", e)

            call.reject(e.message ?: "Native WebRTC release failed", e)
        }
    }

    /*
     * =========================================================
     * NATIVE WEBRTC EVENTS
     * =========================================================
     */

    override fun onIceCandidate(candidate: IceCandidate) {

        val data =
            JSObject().apply {
                put("sdpMid", candidate.sdpMid)

                put("sdpMLineIndex", candidate.sdpMLineIndex)

                put("candidate", candidate.sdp)
            }

        notifyListeners("iceCandidate", data)
    }

    override fun onConnectionStateChanged(state: PeerConnection.PeerConnectionState) {

        notifyListeners(
            "connectionStateChanged",
            JSObject().apply { put("state", state.name.lowercase()) },
        )
    }

    override fun onIceConnectionStateChanged(state: PeerConnection.IceConnectionState) {

        notifyListeners(
            "iceConnectionStateChanged",
            JSObject().apply { put("state", state.name.lowercase()) },
        )
    }

    override fun onRemoteVideoTrack(track: VideoTrack) {

        Log.i(TAG, "Remote VideoTrack received - attaching renderer")

        remoteVideoTrack = track

        rendererManager?.setRemoteTrack(track)

        notifyListeners("remoteVideoTrackAvailable", JSObject().apply { put("available", true) })
    }

    override fun onError(message: String, throwable: Throwable?) {

        Log.e(TAG, message, throwable)

        notifyListeners("error", JSObject().apply { put("message", message) })
    }

    /*
     * =========================================================
     * HELPERS
     * =========================================================
     */

    private fun requireEngine(): NativeWebRtc {

        return engine ?: throw IllegalStateException("Native WebRTC is not initialized")
    }

    private fun sessionDescriptionToJs(description: SessionDescription): JSObject {

        return JSObject().apply {
            put("type", description.type.canonicalForm())

            put("sdp", description.description)
        }
    }

    private fun ensurePermissions() {

        val cameraGranted =
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED

        val microphoneGranted =
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED

        if (!cameraGranted) {

            throw SecurityException("CAMERA permission is not granted")
        }

        if (!microphoneGranted) {

            throw SecurityException("RECORD_AUDIO permission is not granted")
        }
    }

    /*
     * =========================================================
     * DESTROY
     * =========================================================
     */

    override fun handleOnDestroy() {

        remoteVideoTrack = null

        try {

            rendererManager?.release()

            rendererManager = null

            engine?.release()
        } catch (e: Exception) {

            Log.e(TAG, "Native WebRTC destroy failed", e)
        }

        engine = null

        super.handleOnDestroy()
    }
}
