package io.ionic.starter

import android.content.Context
import android.media.AudioFormat
import android.util.Log
import kotlin.math.abs
import org.webrtc.PeerConnectionFactory
import org.webrtc.audio.AudioDeviceModule
import org.webrtc.audio.JavaAudioDeviceModule

/**
 * POC native WebRTC audio owner.
 *
 * Goal:
 *
 * MIC | v WebRTC JavaAudioDeviceModule / AudioRecord | +---- SamplesReadyCallback ----> PCM | +----
 * native WebRTC audio path
 *
 * IMPORTANT: Creating this class does NOT by itself start AudioRecord. WebRTC starts recording when
 * an active native WebRTC audio path requests microphone capture.
 */
class NativeWebRtcAudio(
    private val context: Context,
    private val onPcm16k: (ByteArray) -> Unit,
    private val onError: (String) -> Unit,
) {

    companion object {
        private const val TAG = "LingoWebRtcMic"
        private const val SHERPA_SAMPLE_RATE = 16_000
    }

    private var audioDeviceModule: AudioDeviceModule? = null
    private var peerConnectionFactory: PeerConnectionFactory? = null

    private var callbackCount = 0L

    @Synchronized
    fun initialize() {
        if (audioDeviceModule != null) {
            Log.i(TAG, "Native WebRTC audio already initialized")
            return
        }

        try {
            Log.i(TAG, "★★★★★ INITIALIZING NATIVE WEBRTC AUDIO ★★★★★")

            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                    .createInitializationOptions()
            )

            val adm =
                JavaAudioDeviceModule.builder(context.applicationContext)

                    // For this POC we specifically do NOT want Android HW
                    // AEC/NS altering the AudioRecord signal delivered to
                    // SamplesReadyCallback.
                    .setUseHardwareAcousticEchoCanceler(false)
                    .setUseHardwareNoiseSuppressor(false)
                    .setSamplesReadyCallback { samples ->
                        try {
                            handleSamples(samples)
                        } catch (e: Exception) {
                            Log.e(TAG, "SamplesReadyCallback failed", e)
                            onError(e.message ?: "Native WebRTC audio callback failed")
                        }
                    }
                    .createAudioDeviceModule()

            audioDeviceModule = adm

            peerConnectionFactory =
                PeerConnectionFactory.builder()
                    .setAudioDeviceModule(adm)
                    .createPeerConnectionFactory()

            Log.i(
                TAG,
                "★★★★★ NATIVE WEBRTC AUDIO INITIALIZED - " +
                    "waiting for WebRTC recording to start ★★★★★",
            )
        } catch (e: Exception) {
            Log.e(TAG, "Native WebRTC audio initialization failed", e)

            release()

            onError(e.message ?: "Native WebRTC audio initialization failed")
        }
    }

    private fun handleSamples(samples: JavaAudioDeviceModule.AudioSamples) {
        val data = samples.data ?: return

        if (data.isEmpty()) {
            return
        }

        callbackCount++

        val sampleRate = samples.sampleRate
        val channelCount = samples.channelCount
        val audioFormat = samples.audioFormat

        if (callbackCount <= 10L || callbackCount % 100L == 0L) {
            val peak = calculatePeakPcm16(data)

            Log.i(
                TAG,
                "★★★★★ WEBRTC RAW PCM " +
                    "callback=$callbackCount " +
                    "bytes=${data.size} " +
                    "sampleRate=$sampleRate " +
                    "channels=$channelCount " +
                    "format=$audioFormat " +
                    "peak=$peak ★★★★★",
            )
        }

        if (audioFormat != AudioFormat.ENCODING_PCM_16BIT) {
            Log.w(TAG, "Ignoring unsupported WebRTC PCM format=$audioFormat")
            return
        }

        if (channelCount != 1) {
            Log.w(TAG, "Ignoring unsupported channelCount=$channelCount")
            return
        }

        val pcm16k =
            when (sampleRate) {
                SHERPA_SAMPLE_RATE -> data.copyOf()

                48_000 -> resample48kTo16k(data)

                else -> {
                    Log.w(TAG, "Unsupported WebRTC sampleRate=$sampleRate")
                    return
                }
            }

        if (pcm16k.isNotEmpty()) {
            onPcm16k(pcm16k)
        }
    }

    /**
     * Simple deterministic 48 kHz -> 16 kHz POC downsampler.
     *
     * Takes every third PCM16 sample.
     *
     * This is deliberately simple for the first capture/STT experiment. If the architecture proves
     * correct, replace this with a proper anti-aliasing resampler before production.
     */
    private fun resample48kTo16k(input: ByteArray): ByteArray {
        val inputSamples = input.size / 2

        if (inputSamples < 3) {
            return ByteArray(0)
        }

        val outputSamples = inputSamples / 3
        val output = ByteArray(outputSamples * 2)

        var inputSample = 0
        var outputByte = 0

        while (inputSample + 2 < inputSamples && outputByte + 1 < output.size) {
            val inputByte = inputSample * 2

            output[outputByte] = input[inputByte]
            output[outputByte + 1] = input[inputByte + 1]

            inputSample += 3
            outputByte += 2
        }

        return output
    }

    private fun calculatePeakPcm16(data: ByteArray): Int {
        var peak = 0
        var i = 0

        while (i + 1 < data.size) {
            val sample =
                ((data[i + 1].toInt() shl 8) or (data[i].toInt() and 0xff)).toShort().toInt()

            peak = maxOf(peak, abs(sample))

            i += 2
        }

        return peak
    }

    fun getFactory(): PeerConnectionFactory? = peerConnectionFactory

    fun getAudioDeviceModule(): AudioDeviceModule? = audioDeviceModule

    @Synchronized
    fun release() {
        Log.i(TAG, "★★★★★ RELEASING NATIVE WEBRTC AUDIO " + "callbacks=$callbackCount ★★★★★")

        try {
            peerConnectionFactory?.dispose()
        } catch (e: Exception) {
            Log.w(TAG, "PeerConnectionFactory dispose failed", e)
        }

        peerConnectionFactory = null

        try {
            audioDeviceModule?.release()
        } catch (e: Exception) {
            Log.w(TAG, "AudioDeviceModule release failed", e)
        }

        audioDeviceModule = null
        callbackCount = 0
    }
}
