package io.ionic.starter

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule

class NativeWebRtc(private val context: Context, private val listener: Listener) {

    companion object {

        private const val TAG = "LingoNativeWebRtc"

        private const val LOCAL_AUDIO_TRACK_ID = "lingo-audio"

        private const val LOCAL_VIDEO_TRACK_ID = "lingo-video"

        private const val STREAM_ID = "lingo-stream"

        private const val CAMERA_WIDTH = 1280

        private const val CAMERA_HEIGHT = 720

        private const val CAMERA_FPS = 30
    }

    interface Listener {

        fun onIceCandidate(candidate: IceCandidate)

        fun onConnectionStateChanged(state: PeerConnection.PeerConnectionState)

        fun onIceConnectionStateChanged(state: PeerConnection.IceConnectionState)

        fun onRemoteVideoTrack(track: VideoTrack)

        fun onError(message: String, throwable: Throwable? = null)
    }

    /*
     * =========================================================
     * CORE WEBRTC OBJECTS
     * =========================================================
     */

    private val eglBase = EglBase.create()

    private var audioDeviceModule: JavaAudioDeviceModule? = null

    private var peerConnectionFactory: PeerConnectionFactory? = null

    private var peerConnection: PeerConnection? = null

    /*
     * =========================================================
     * AUDIO
     * =========================================================
     */

    private var audioSource: AudioSource? = null

    private var localAudioTrack: AudioTrack? = null

    private val audioManager =
        context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private var previousAudioMode: Int? = null

    @Suppress("DEPRECATION") private var previousSpeakerphoneOn: Boolean? = null

    private var previousCommunicationDevice: AudioDeviceInfo? = null

    private var speakerphoneConfigured = false

    /*
     * =========================================================
     * VIDEO
     * =========================================================
     */

    private var videoSource: VideoSource? = null

    private var localVideoTrack: VideoTrack? = null

    private var cameraCapturer: CameraVideoCapturer? = null

    private var surfaceTextureHelper: SurfaceTextureHelper? = null

    /*
     * =========================================================
     * STATE
     * =========================================================
     */

    private val initialized = AtomicBoolean(false)

    private var cameraEnabled = true

    private var microphoneEnabled = true

    private var released = false

    /*
     * =========================================================
     * PCM
     * =========================================================
     */

    private val pcmResampler = Pcm48To16Resampler()

    /*
     * Diagnostic only: aggregate the ADM input and resampler output into
     * ~100 ms windows. This does not alter, gate, buffer, or normalize PCM.
     */
    private var pcmDiagCallbacks = 0
    private var pcmDiag48Samples = 0L
    private var pcmDiag48SumSquares = 0.0
    private var pcmDiag48Peak = 0
    private var pcmDiag48ZeroCallbacks = 0
    private var pcmDiag16Samples = 0L
    private var pcmDiag16SumSquares = 0.0
    private var pcmDiag16Peak = 0
    private var pcmDiag16ZeroCallbacks = 0
    private var pcmDiagWindow = 0L

    /*
     * =========================================================
     * INITIALIZATION
     * =========================================================
     */

    @Synchronized
    fun initialize() {

        if (initialized.get()) {
            return
        }

        check(!released) { "NativeWebRtc has already been released" }

        Log.i(TAG, "Initializing native WebRTC")

        configureSpeakerphoneAudioRoute()

        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                .setEnableInternalTracer(false)
                .createInitializationOptions()
        )

        /*
         * IMPORTANT:
         *
         * This ADM owns the microphone.
         *
         * SamplesReadyCallback gives us a COPY of the PCM
         * being captured by WebRTC.
         *
         * Sherpa does NOT create AudioRecord anymore.
         */

        audioDeviceModule =
            JavaAudioDeviceModule.builder(context.applicationContext)
                .setUseHardwareAcousticEchoCanceler(true)
                .setUseHardwareNoiseSuppressor(true)
                .setSamplesReadyCallback { samples -> handleRecordedAudio(samples) }
                .createAudioDeviceModule()

        val encoderFactory = DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true)

        val decoderFactory = DefaultVideoDecoderFactory(eglBase.eglBaseContext)

        peerConnectionFactory =
            PeerConnectionFactory.builder()
                .setAudioDeviceModule(audioDeviceModule)
                .setVideoEncoderFactory(encoderFactory)
                .setVideoDecoderFactory(decoderFactory)
                .createPeerConnectionFactory()

        createLocalAudio()

        createLocalVideo()

        initialized.set(true)

        Log.i(TAG, "Native WebRTC initialized")
    }

    /*
     * =========================================================
     * CALL AUDIO ROUTING
     * =========================================================
     */

    @Suppress("DEPRECATION")
    private fun configureSpeakerphoneAudioRoute() {

        if (speakerphoneConfigured) {
            return
        }

        previousAudioMode = audioManager.mode
        previousSpeakerphoneOn = audioManager.isSpeakerphoneOn

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            previousCommunicationDevice = audioManager.communicationDevice
        }

        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {

            val speaker =
                audioManager.availableCommunicationDevices.firstOrNull {
                    it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                }

            if (speaker != null) {

                val selected = audioManager.setCommunicationDevice(speaker)

                Log.i(
                    TAG,
                    "Speakerphone route requested via setCommunicationDevice: selected=$selected device=${speaker.productName}",
                )
            } else {

                Log.w(TAG, "Built-in speaker is not available as a communication device")
            }
        } else {

            audioManager.isSpeakerphoneOn = true

            Log.i(TAG, "Speakerphone route enabled via legacy AudioManager API")
        }

        speakerphoneConfigured = true

        Log.i(
            TAG,
            "Call audio configured: mode=${audioManager.mode}, speakerphone=${audioManager.isSpeakerphoneOn}",
        )
    }

    @Suppress("DEPRECATION")
    private fun restoreAudioRoute() {

        if (!speakerphoneConfigured) {
            return
        }

        try {

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {

                audioManager.clearCommunicationDevice()

                previousCommunicationDevice?.let { previousDevice ->
                    val stillAvailable =
                        audioManager.availableCommunicationDevices.any {
                            it.id == previousDevice.id
                        }

                    if (stillAvailable) {
                        audioManager.setCommunicationDevice(previousDevice)
                    }
                }
            } else {

                previousSpeakerphoneOn?.let { wasOn -> audioManager.isSpeakerphoneOn = wasOn }
            }

            previousAudioMode?.let { oldMode -> audioManager.mode = oldMode }

            Log.i(
                TAG,
                "Call audio route restored: mode=${audioManager.mode}, speakerphone=${audioManager.isSpeakerphoneOn}",
            )
        } catch (e: Exception) {

            Log.w(TAG, "Failed restoring previous audio route", e)
        } finally {

            previousAudioMode = null
            previousSpeakerphoneOn = null
            previousCommunicationDevice = null
            speakerphoneConfigured = false
        }
    }

    /*
     * =========================================================
     * LOCAL AUDIO
     * =========================================================
     */

    private fun createLocalAudio() {

        val factory = requireNotNull(peerConnectionFactory)

        /*
         * Do not disable WebRTC audio processing here.
         *
         * We want WebRTC voice-call processing for the
         * actual call.
         */

        val constraints = MediaConstraints()

        audioSource = factory.createAudioSource(constraints)

        localAudioTrack =
            factory.createAudioTrack(LOCAL_AUDIO_TRACK_ID, audioSource).apply {
                setEnabled(microphoneEnabled)
            }

        Log.i(TAG, "Local AudioTrack created")
    }

    /*
     * =========================================================
     * LOCAL VIDEO
     * =========================================================
     */

    private fun createLocalVideo() {

        val factory = requireNotNull(peerConnectionFactory)

        val capturer = createCameraCapturer()

        val source = factory.createVideoSource(false)

        val textureHelper =
            SurfaceTextureHelper.create("LingoCameraCapture", eglBase.eglBaseContext)

        capturer.initialize(textureHelper, context.applicationContext, source.capturerObserver)

        capturer.startCapture(CAMERA_WIDTH, CAMERA_HEIGHT, CAMERA_FPS)

        val track = factory.createVideoTrack(LOCAL_VIDEO_TRACK_ID, source)

        track.setEnabled(cameraEnabled)

        cameraCapturer = capturer

        videoSource = source

        surfaceTextureHelper = textureHelper

        localVideoTrack = track

        Log.i(TAG, "Local VideoTrack created")
    }

    private fun createCameraCapturer(): CameraVideoCapturer {

        val enumerator = Camera2Enumerator(context)

        /*
         * Prefer front camera.
         */

        enumerator.deviceNames
            .firstOrNull { enumerator.isFrontFacing(it) }
            ?.let { name ->
                val capturer = enumerator.createCapturer(name, null)

                if (capturer != null) {

                    Log.i(TAG, "Using front camera: $name")

                    return capturer
                }
            }

        /*
         * Fallback to any available camera.
         */

        enumerator.deviceNames.firstOrNull()?.let { name ->
            val capturer = enumerator.createCapturer(name, null)

            if (capturer != null) {

                Log.i(TAG, "Using fallback camera: $name")

                return capturer
            }
        }

        throw IllegalStateException("No usable camera found")
    }

    /*
     * =========================================================
     * PEER CONNECTION
     * =========================================================
     */

    @Synchronized
    fun createPeerConnection() {

        ensureInitialized()

        /*
         * Always destroy the old call before creating
         * a new PeerConnection.
         *
         * Camera/microphone sources themselves remain alive.
         */

        closePeerConnection()

        val factory = requireNotNull(peerConnectionFactory)

        val iceServers =
            listOf(
                PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()
            )

        val rtcConfig =
            PeerConnection.RTCConfiguration(iceServers).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN

                continualGatheringPolicy =
                    PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            }

        val pc =
            factory.createPeerConnection(rtcConfig, peerObserver)
                ?: throw IllegalStateException("Failed to create PeerConnection")

        /*
         * One PeerConnection.
         *
         * Both tracks are published on it.
         */

        val audioTrack = requireNotNull(localAudioTrack)

        val videoTrack = requireNotNull(localVideoTrack)

        pc.addTrack(audioTrack, listOf(STREAM_ID))

        pc.addTrack(videoTrack, listOf(STREAM_ID))

        peerConnection = pc

        Log.i(TAG, "PeerConnection created with audio + video")
    }

    /*
     * =========================================================
     * OFFER
     * =========================================================
     */

    fun createOffer(callback: (Result<SessionDescription>) -> Unit) {

        val pc = peerConnection

        if (pc == null) {

            callback(Result.failure(IllegalStateException("PeerConnection is not created")))

            return
        }

        val constraints =
            MediaConstraints().apply {
                mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))

                mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "true"))
            }

        pc.createOffer(
            object : SimpleSdpObserver() {

                override fun onCreateSuccess(description: SessionDescription) {

                    pc.setLocalDescription(
                        object : SimpleSdpObserver() {

                            override fun onSetSuccess() {

                                callback(Result.success(description))
                            }

                            override fun onSetFailure(error: String) {

                                callback(Result.failure(IllegalStateException(error)))
                            }
                        },
                        description,
                    )
                }

                override fun onCreateFailure(error: String) {

                    callback(Result.failure(IllegalStateException(error)))
                }
            },
            constraints,
        )
    }

    /*
     * =========================================================
     * REMOTE OFFER -> ANSWER
     * =========================================================
     */

    fun acceptOffer(sdp: String, callback: (Result<SessionDescription>) -> Unit) {

        val pc = peerConnection

        if (pc == null) {

            callback(Result.failure(IllegalStateException("PeerConnection is not created")))

            return
        }

        val remoteOffer = SessionDescription(SessionDescription.Type.OFFER, sdp)

        pc.setRemoteDescription(
            object : SimpleSdpObserver() {

                override fun onSetSuccess() {

                    createAnswer(callback)
                }

                override fun onSetFailure(error: String) {

                    callback(Result.failure(IllegalStateException(error)))
                }
            },
            remoteOffer,
        )
    }

    private fun createAnswer(callback: (Result<SessionDescription>) -> Unit) {

        val pc = peerConnection

        if (pc == null) {

            callback(Result.failure(IllegalStateException("PeerConnection is not created")))

            return
        }

        val constraints = MediaConstraints()

        pc.createAnswer(
            object : SimpleSdpObserver() {

                override fun onCreateSuccess(description: SessionDescription) {

                    pc.setLocalDescription(
                        object : SimpleSdpObserver() {

                            override fun onSetSuccess() {

                                callback(Result.success(description))
                            }

                            override fun onSetFailure(error: String) {

                                callback(Result.failure(IllegalStateException(error)))
                            }
                        },
                        description,
                    )
                }

                override fun onCreateFailure(error: String) {

                    callback(Result.failure(IllegalStateException(error)))
                }
            },
            constraints,
        )
    }

    /*
     * =========================================================
     * REMOTE ANSWER
     * =========================================================
     */

    fun acceptAnswer(sdp: String, callback: (Result<Unit>) -> Unit) {

        val pc = peerConnection

        if (pc == null) {

            callback(Result.failure(IllegalStateException("PeerConnection is not created")))

            return
        }

        val answer = SessionDescription(SessionDescription.Type.ANSWER, sdp)

        pc.setRemoteDescription(
            object : SimpleSdpObserver() {

                override fun onSetSuccess() {

                    callback(Result.success(Unit))
                }

                override fun onSetFailure(error: String) {

                    callback(Result.failure(IllegalStateException(error)))
                }
            },
            answer,
        )
    }

    /*
     * =========================================================
     * ICE
     * =========================================================
     */

    fun addIceCandidate(sdpMid: String?, sdpMLineIndex: Int, candidate: String): Boolean {

        val pc = peerConnection ?: return false

        return pc.addIceCandidate(IceCandidate(sdpMid, sdpMLineIndex, candidate))
    }

    /*
     * =========================================================
     * MICROPHONE
     * =========================================================
     */

    fun setMicrophoneEnabled(enabled: Boolean) {

        microphoneEnabled = enabled

        localAudioTrack?.setEnabled(enabled)

        Log.i(TAG, "Microphone enabled=$enabled")
    }

    /*
     * =========================================================
     * CAMERA
     * =========================================================
     */

    fun setCameraEnabled(enabled: Boolean) {

        cameraEnabled = enabled

        localVideoTrack?.setEnabled(enabled)

        Log.i(TAG, "Camera enabled=$enabled")
    }

    fun switchCamera(callback: (Result<Unit>) -> Unit) {

        val capturer = cameraCapturer

        if (capturer == null) {

            callback(Result.failure(IllegalStateException("Camera is not initialized")))

            return
        }

        capturer.switchCamera(
            object : CameraVideoCapturer.CameraSwitchHandler {

                override fun onCameraSwitchDone(isFrontCamera: Boolean) {

                    Log.i(TAG, "Camera switched. front=$isFrontCamera")

                    callback(Result.success(Unit))
                }

                override fun onCameraSwitchError(errorDescription: String) {

                    callback(Result.failure(IllegalStateException(errorDescription)))
                }
            }
        )
    }

    /*
     * =========================================================
     * TRACK ACCESS FOR RENDERER
     * =========================================================
     */

    fun getEglContext(): EglBase.Context {

        return eglBase.eglBaseContext
    }

    fun getLocalVideoTrack(): VideoTrack? {

        return localVideoTrack
    }

    /*
     * =========================================================
     * PCM FROM WEBRTC ADM
     * =========================================================
     */

    private fun handleRecordedAudio(samples: JavaAudioDeviceModule.AudioSamples) {

        if (samples.audioFormat != android.media.AudioFormat.ENCODING_PCM_16BIT) {
            return
        }

        if (samples.channelCount != 1) {
            Log.w(TAG, "Ignoring non-mono WebRTC PCM channels=${samples.channelCount}")
            return
        }

        val raw = samples.data
        if (raw.isEmpty()) {
            return
        }

        val pcm16k =
            when (samples.sampleRate) {
                16_000 -> raw.copyOf()
                48_000 -> pcmResampler.process(raw)
                else -> {
                    Log.w(TAG, "Unsupported WebRTC PCM sampleRate=${samples.sampleRate}")
                    return
                }
            }

        // Diagnostics observe copies already supplied by the ADM callback.
        // They never modify the bytes forwarded to NativePcmBus.
        updatePcmDiagnostics(raw, samples.sampleRate, pcm16k)

        if (pcm16k.isNotEmpty()) {
            NativePcmBus.publish(pcm16k)
        }
    }

    private fun updatePcmDiagnostics(raw: ByteArray, rawSampleRate: Int, pcm16k: ByteArray) {
        val rawStats = pcm16Stats(raw)
        val outStats = pcm16Stats(pcm16k)

        pcmDiagCallbacks += 1

        // Label this side 48k when it really is 48 kHz. A 16-kHz passthrough is
        // still reported here as ADM input so the log remains truthful.
        pcmDiag48Samples += rawStats.sampleCount
        pcmDiag48SumSquares += rawStats.sumSquares
        pcmDiag48Peak = maxOf(pcmDiag48Peak, rawStats.peak)
        if (rawStats.peak == 0) pcmDiag48ZeroCallbacks += 1

        pcmDiag16Samples += outStats.sampleCount
        pcmDiag16SumSquares += outStats.sumSquares
        pcmDiag16Peak = maxOf(pcmDiag16Peak, outStats.peak)
        if (outStats.peak == 0) pcmDiag16ZeroCallbacks += 1

        // WebRTC normally calls SamplesReadyCallback every ~10 ms. Ten callbacks
        // therefore line up closely with the 100-ms Sherpa accumulator chunks.
        if (pcmDiagCallbacks >= 10) {
            pcmDiagWindow += 1

            val inRms = normalizedRms(pcmDiag48SumSquares, pcmDiag48Samples)
            val outRms = normalizedRms(pcmDiag16SumSquares, pcmDiag16Samples)
            val inPeak = pcmDiag48Peak / 32768.0
            val outPeak = pcmDiag16Peak / 32768.0

            Log.i(
                TAG,
                "PCM_DIAG window=$pcmDiagWindow " +
                    "admRate=$rawSampleRate " +
                    "inPeak=${"%.4f".format(java.util.Locale.US, inPeak)} " +
                    "inRms=${"%.4f".format(java.util.Locale.US, inRms)} " +
                    "inSamples=$pcmDiag48Samples inZeroCallbacks=$pcmDiag48ZeroCallbacks/10 " +
                    "out16Peak=${"%.4f".format(java.util.Locale.US, outPeak)} " +
                    "out16Rms=${"%.4f".format(java.util.Locale.US, outRms)} " +
                    "out16Samples=$pcmDiag16Samples outZeroCallbacks=$pcmDiag16ZeroCallbacks/10",
            )

            resetPcmDiagnosticWindow()
        }
    }

    private data class PcmStats(
        val sampleCount: Long,
        val sumSquares: Double,
        val peak: Int,
    )

    private fun pcm16Stats(bytes: ByteArray): PcmStats {
        var index = 0
        var count = 0L
        var sumSquares = 0.0
        var peak = 0

        while (index + 1 < bytes.size) {
            val lo = bytes[index].toInt() and 0xff
            val hi = bytes[index + 1].toInt()
            val sample = ((hi shl 8) or lo).toShort().toInt()
            val absSample = kotlin.math.abs(sample)

            if (absSample > peak) peak = absSample
            val normalized = sample / 32768.0
            sumSquares += normalized * normalized
            count += 1
            index += 2
        }

        return PcmStats(count, sumSquares, peak)
    }

    private fun normalizedRms(sumSquares: Double, sampleCount: Long): Double {
        if (sampleCount <= 0L) return 0.0
        return kotlin.math.sqrt(sumSquares / sampleCount.toDouble())
    }

    private fun resetPcmDiagnosticWindow() {
        pcmDiagCallbacks = 0
        pcmDiag48Samples = 0L
        pcmDiag48SumSquares = 0.0
        pcmDiag48Peak = 0
        pcmDiag48ZeroCallbacks = 0
        pcmDiag16Samples = 0L
        pcmDiag16SumSquares = 0.0
        pcmDiag16Peak = 0
        pcmDiag16ZeroCallbacks = 0
    }

    /*
     * =========================================================
     * PEER OBSERVER
     * =========================================================
     */

    private val peerObserver =
        object : PeerConnection.Observer {

            override fun onSignalingChange(state: PeerConnection.SignalingState) {

                Log.d(TAG, "Signaling state=$state")
            }

            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {

                Log.i(TAG, "ICE state=$state")

                listener.onIceConnectionStateChanged(state)
            }

            override fun onStandardizedIceConnectionChange(
                newState: PeerConnection.IceConnectionState
            ) {

                Log.i(TAG, "Standardized ICE state=$newState")
            }

            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {

                Log.i(TAG, "Connection state=$newState")

                listener.onConnectionStateChanged(newState)
            }

            override fun onIceConnectionReceivingChange(receiving: Boolean) {}

            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {

                Log.d(TAG, "ICE gathering=$state")
            }

            override fun onIceCandidate(candidate: IceCandidate) {

                listener.onIceCandidate(candidate)
            }

            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}

            override fun onAddStream(stream: MediaStream) {

                /*
                 * Legacy callback.
                 *
                 * Unified Plan uses onTrack().
                 */
            }

            override fun onRemoveStream(stream: MediaStream) {}

            override fun onDataChannel(dataChannel: org.webrtc.DataChannel) {}

            override fun onRenegotiationNeeded() {

                Log.d(TAG, "Renegotiation needed")
            }

            override fun onAddTrack(receiver: RtpReceiver, mediaStreams: Array<out MediaStream>) {

                val track = receiver.track()

                if (track is VideoTrack) {

                    Log.i(TAG, "Remote VideoTrack received")

                    listener.onRemoteVideoTrack(track)
                }
            }

            override fun onTrack(transceiver: org.webrtc.RtpTransceiver) {

                val track = transceiver.receiver.track()

                if (track is VideoTrack) {

                    Log.i(TAG, "Remote VideoTrack received via onTrack")

                    listener.onRemoteVideoTrack(track)
                }
            }
        }

    /*
     * =========================================================
     * CLOSE CURRENT CALL
     * =========================================================
     */

    @Synchronized
    fun closePeerConnection() {

        peerConnection?.let { pc ->
            try {

                pc.close()
            } catch (e: Exception) {

                Log.w(TAG, "PeerConnection close failed", e)
            }

            try {

                pc.dispose()
            } catch (e: Exception) {

                Log.w(TAG, "PeerConnection dispose failed", e)
            }
        }

        peerConnection = null

        Log.i(TAG, "PeerConnection closed")
    }

    /*
     * =========================================================
     * FULL RELEASE
     * =========================================================
     */

    @Synchronized
    fun release() {

        if (released) {
            return
        }

        released = true

        Log.i(TAG, "Releasing native WebRTC")

        closePeerConnection()

        /*
         * Stop camera first.
         */

        try {

            cameraCapturer?.stopCapture()
        } catch (e: InterruptedException) {

            Thread.currentThread().interrupt()
        } catch (e: Exception) {

            Log.w(TAG, "Camera stop failed", e)
        }

        try {

            cameraCapturer?.dispose()
        } catch (e: Exception) {

            Log.w(TAG, "Camera dispose failed", e)
        }

        cameraCapturer = null

        localVideoTrack?.dispose()

        localVideoTrack = null

        videoSource?.dispose()

        videoSource = null

        surfaceTextureHelper?.dispose()

        surfaceTextureHelper = null

        localAudioTrack?.dispose()

        localAudioTrack = null

        audioSource?.dispose()

        audioSource = null

        peerConnectionFactory?.dispose()

        peerConnectionFactory = null

        /*
         * Release ADM only after PeerConnectionFactory.
         */

        audioDeviceModule?.release()

        audioDeviceModule = null

        restoreAudioRoute()

        pcmResampler.reset()
        resetPcmDiagnosticWindow()

        try {

            eglBase.release()
        } catch (e: Exception) {

            Log.w(TAG, "EGL release failed", e)
        }

        initialized.set(false)

        Log.i(TAG, "Native WebRTC released")
    }

    private fun ensureInitialized() {

        check(initialized.get()) { "NativeWebRtc is not initialized" }
    }

    /*
     * =========================================================
     * SDP HELPER
     * =========================================================
     */

    private open class SimpleSdpObserver : SdpObserver {

        override fun onCreateSuccess(sessionDescription: SessionDescription) {}

        override fun onSetSuccess() {}

        override fun onCreateFailure(error: String) {}

        override fun onSetFailure(error: String) {}
    }
}
