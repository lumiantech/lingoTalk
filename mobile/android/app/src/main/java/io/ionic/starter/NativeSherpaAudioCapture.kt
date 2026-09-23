package io.ionic.starter

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs

/**
 * Dedicated native microphone capture for Sherpa.
 *
 * WebRTC keeps its own WebView microphone track with AEC enabled.
 * Sherpa no longer receives PCM from that WebRTC track.
 *
 * Native STT path:
 *   microphone -> AudioRecord -> PCM16/16kHz/mono -> Sherpa
 *
 * We request UNPROCESSED when Android reports support; otherwise MIC.
 * AEC/NS/AGC are explicitly disabled for this AudioRecord session when
 * the corresponding Android audio effects are available.
 */
class NativeSherpaAudioCapture(
    private val context: Context,
    private val onPcm: (ByteArray) -> Unit,
    private val onError: (String) -> Unit,
) {
    companion object {
        private const val TAG = "LingoNativeMic"
        private const val SAMPLE_RATE = 16_000
        private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        private const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
        private const val CHUNK_MS = 100
        private const val BYTES_PER_SAMPLE = 2
        private const val CHUNK_BYTES =
            SAMPLE_RATE * CHUNK_MS / 1000 * BYTES_PER_SAMPLE
    }

    private val running = AtomicBoolean(false)

    @Volatile
    private var audioRecord: AudioRecord? = null

    private var captureThread: Thread? = null

    private var aec: AcousticEchoCanceler? = null
    private var ns: NoiseSuppressor? = null
    private var agc: AutomaticGainControl? = null

    @Synchronized
    fun start() {
        if (running.get()) {
            Log.i(TAG, "Native Sherpa microphone already running")
            return
        }

        if (
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.RECORD_AUDIO,
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            onError("RECORD_AUDIO permission is not granted")
            return
        }

        try {
            val audioManager =
                context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

            val unprocessedSupported =
                audioManager.getProperty(
                    AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED,
                ) == "true"

            val source =
                if (unprocessedSupported) {
                    MediaRecorder.AudioSource.UNPROCESSED
                } else {
                    MediaRecorder.AudioSource.MIC
                }

            val minBuffer =
                AudioRecord.getMinBufferSize(
                    SAMPLE_RATE,
                    CHANNEL_CONFIG,
                    AUDIO_FORMAT,
                )

            if (minBuffer <= 0) {
                throw IllegalStateException(
                    "AudioRecord.getMinBufferSize failed: $minBuffer",
                )
            }

            val bufferSize =
                maxOf(
                    minBuffer * 2,
                    CHUNK_BYTES * 4,
                )

            val record =
                AudioRecord(
                    source,
                    SAMPLE_RATE,
                    CHANNEL_CONFIG,
                    AUDIO_FORMAT,
                    bufferSize,
                )

            if (record.state != AudioRecord.STATE_INITIALIZED) {
                record.release()
                throw IllegalStateException("AudioRecord failed to initialize")
            }

            disableInputEffects(record.audioSessionId)

            audioRecord = record
            running.set(true)

            Log.i(
                TAG,
                "★★★★★ NATIVE STT MIC START " +
                    "source=${sourceName(source)} " +
                    "unprocessedSupported=$unprocessedSupported " +
                    "sampleRate=$SAMPLE_RATE " +
                    "session=${record.audioSessionId} " +
                    "bufferSize=$bufferSize ★★★★★",
            )

            record.startRecording()

            if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                throw IllegalStateException(
                    "AudioRecord did not enter RECORDSTATE_RECORDING",
                )
            }

            captureThread =
                Thread(
                    { captureLoop(record) },
                    "Lumian-Sherpa-Mic",
                ).apply {
                    priority = Thread.MAX_PRIORITY
                    start()
                }
        } catch (e: Exception) {
            Log.e(TAG, "Native STT microphone start failed", e)
            stopInternal()
            onError(e.message ?: "Native STT microphone start failed")
        }
    }

    private fun captureLoop(record: AudioRecord) {
        val buffer = ByteArray(CHUNK_BYTES)
        var chunkCount = 0L

        while (running.get()) {
            var offset = 0

            while (running.get() && offset < buffer.size) {
                val count =
                    record.read(
                        buffer,
                        offset,
                        buffer.size - offset,
                        AudioRecord.READ_BLOCKING,
                    )

                if (count > 0) {
                    offset += count
                    continue
                }

                if (count == AudioRecord.ERROR_DEAD_OBJECT) {
                    failFromCaptureThread("AudioRecord ERROR_DEAD_OBJECT")
                    return
                }

                if (count == AudioRecord.ERROR_INVALID_OPERATION) {
                    failFromCaptureThread("AudioRecord ERROR_INVALID_OPERATION")
                    return
                }

                if (count == AudioRecord.ERROR_BAD_VALUE) {
                    failFromCaptureThread("AudioRecord ERROR_BAD_VALUE")
                    return
                }

                if (count < 0) {
                    failFromCaptureThread("AudioRecord read failed: $count")
                    return
                }
            }

            if (!running.get()) {
                break
            }

            if (offset == buffer.size) {
                chunkCount++

                if (chunkCount <= 5L || chunkCount % 50L == 0L) {
                    var peak = 0
                    var i = 0

                    while (i + 1 < buffer.size) {
                        val sample =
                            ((buffer[i + 1].toInt() shl 8) or
                                (buffer[i].toInt() and 0xff)).toShort().toInt()

                        peak = maxOf(peak, abs(sample))
                        i += 2
                    }

                    Log.i(
                        TAG,
                        "★★★★★ PCM chunk=$chunkCount " +
                            "bytes=${buffer.size} peak=$peak ★★★★★",
                    )
                }

                onPcm(buffer.copyOf())
            }
        }

        Log.i(TAG, "Native STT capture loop ended")
    }

    private fun disableInputEffects(audioSessionId: Int) {
        try {
            if (AcousticEchoCanceler.isAvailable()) {
                aec = AcousticEchoCanceler.create(audioSessionId)
                aec?.enabled = false
                Log.i(TAG, "Native STT AEC enabled=${aec?.enabled}")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not disable native STT AEC", e)
        }

        try {
            if (NoiseSuppressor.isAvailable()) {
                ns = NoiseSuppressor.create(audioSessionId)
                ns?.enabled = false
                Log.i(TAG, "Native STT NS enabled=${ns?.enabled}")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not disable native STT NS", e)
        }

        try {
            if (AutomaticGainControl.isAvailable()) {
                agc = AutomaticGainControl.create(audioSessionId)
                agc?.enabled = false
                Log.i(TAG, "Native STT AGC enabled=${agc?.enabled}")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not disable native STT AGC", e)
        }
    }

    private fun failFromCaptureThread(message: String) {
        Log.e(TAG, message)
        running.set(false)
        onError(message)
    }

    @Synchronized
    fun stop() {
        if (!running.get() && audioRecord == null) {
            return
        }

        Log.i(TAG, "★★★★★ NATIVE STT MIC STOP ★★★★★")
        stopInternal()
    }

    private fun stopInternal() {
        running.set(false)

        val record = audioRecord
        audioRecord = null

        try {
            record?.stop()
        } catch (_: Exception) {
        }

        try {
            record?.release()
        } catch (_: Exception) {
        }

        try {
            if (captureThread != Thread.currentThread()) {
                captureThread?.join(500)
            }
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }

        captureThread = null

        try {
            aec?.release()
        } catch (_: Exception) {
        }
        try {
            ns?.release()
        } catch (_: Exception) {
        }
        try {
            agc?.release()
        } catch (_: Exception) {
        }

        aec = null
        ns = null
        agc = null
    }

    private fun sourceName(source: Int): String =
        when (source) {
            MediaRecorder.AudioSource.UNPROCESSED -> "UNPROCESSED"
            MediaRecorder.AudioSource.MIC -> "MIC"
            else -> source.toString()
        }
}
