package io.ionic.starter

import android.content.Context
import android.util.Log
import com.k2fsa.sherpa.onnx.EndpointConfig
import com.k2fsa.sherpa.onnx.EndpointRule
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import java.io.File
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.sqrt

class SherpaStreamingRecognizer(private val context: Context, private val listener: Listener) {

    interface Listener {
        fun onSherpaReady(language: String)

        fun onSherpaPartial(text: String, language: String)

        fun onSherpaFinal(text: String, language: String)

        fun onSherpaError(message: String)
    }

    companion object {
        private const val TAG = "LingoSherpa"
        private const val SAMPLE_RATE = 16000
        private const val MODEL_DIR = SherpaModelInstaller.MODEL_DIR

        // Diagnostic only. These thresholds do NOT gate audio and do NOT
        // affect recognition. They only make the next log easier to read.
        private const val SPEECH_RMS_LOG_THRESHOLD = 0.003f
        private const val SPEECH_PEAK_LOG_THRESHOLD = 0.02f
    }

    private val executor = Executors.newSingleThreadExecutor()

    @Volatile private var running = false

    private var recognizer: OnlineRecognizer? = null
    private var stream: OnlineStream? = null

    private var language = "auto"
    private var lastText = ""

    // ============================================================
    // DIAGNOSTICS
    // ============================================================

    private var pcmChunkCount = 0L
    private var totalPcmBytes = 0L
    private var totalSamples = 0L
    private var decodeCount = 0L
    private var resultCheckCount = 0L

    // ============================================================
    // REAL-TIME / BACKLOG DIAGNOSTICS
    // ============================================================
    //
    // Each input chunk is 100 ms of 16 kHz PCM. We timestamp it
    // BEFORE enqueueing it on the single Sherpa executor. When the
    // executor eventually starts that task, enqueueDelayMs tells us
    // exactly how far Sherpa has fallen behind real time.
    //
    // Diagnostic only: this does not alter PCM, endpointing,
    // decoding, stream state, or recognition results.
    private val timingLock = Any()
    private var submittedChunkCount = 0L
    private var completedChunkCount = 0L
    private var queuedChunkCount = 0L
    private var maxQueuedChunkCount = 0L
    private var maxEnqueueDelayMs = 0.0
    private var totalProcessingMs = 0.0
    private var totalDecodeMs = 0.0
    private var totalAcceptedAudioMs = 0.0
    private var timingStartedNs = 0L

    // ============================================================
    // SPEECH / ENDPOINT DIAGNOSTICS
    // ============================================================

    private var endpointLatched = false
    private var endpointResetCount = 0L

    // ============================================================
    // START
    // ============================================================

    fun start(locale: String) {

        language = toSherpaLanguage(locale)
        running = true

        Log.i(TAG, "★★★★★ START requested locale=$locale sherpaLanguage=$language ★★★★★")

        executor.execute {
            try {

                releaseInternal()

                if (!SherpaModelInstaller.isInstalled(context)) {

                    Log.i(TAG, "★★★★★ SHERPA MODEL MISSING - STARTING DOWNLOAD ★★★★★")

                    SherpaModelInstaller.ensureInstalled(context) { progress ->
                        Log.i(TAG, "★★★★★ MODEL DOWNLOAD PROGRESS=$progress% ★★★★★")
                    }
                }

                val dir = File(context.filesDir, MODEL_DIR)

                val encoder = File(dir, "encoder.int8.onnx")
                val decoder = File(dir, "decoder.int8.onnx")
                val joiner = File(dir, "joiner.int8.onnx")
                val tokens = File(dir, "tokens.txt")

                Log.i(TAG, "★★★★★ MODEL DIRECTORY: ${dir.absolutePath} ★★★★★")

                Log.i(
                    TAG,
                    "★★★★★ MODEL FILES: " +
                        "encoder=${encoder.length()} " +
                        "decoder=${decoder.length()} " +
                        "joiner=${joiner.length()} " +
                        "tokens=${tokens.length()} ★★★★★",
                )

                val missing = listOf(encoder, decoder, joiner, tokens).filterNot { it.isFile }

                if (missing.isNotEmpty()) {

                    throw IllegalStateException(
                        "Sherpa model is not installed. Missing: " +
                            "${missing.joinToString { it.name }}. " +
                            "Expected directory: ${dir.absolutePath}"
                    )
                }

                val modelConfig =
                    OnlineModelConfig(
                        transducer =
                            OnlineTransducerModelConfig(
                                encoder = encoder.absolutePath,
                                decoder = decoder.absolutePath,
                                joiner = joiner.absolutePath,
                            ),
                        tokens = tokens.absolutePath,
                        numThreads = 4,
                        debug = false,
                        provider = "cpu",
                    )

                val endpointConfig =
                    EndpointConfig(
                        // Empty/silence endpoint is deliberately pushed far away.
                        // We do not want normal pauses to create empty endpoints.
                        rule1 = EndpointRule(
                            mustContainNonSilence = false,
                            minTrailingSilence = 30.0f,
                            minUtteranceLength = 0.0f,
                        ),
                        // Normal speech endpoint. Keep the existing 1.8 s value for this
                        // controlled test so we change endpoint lifecycle, not tuning.
                        rule2 = EndpointRule(
                            mustContainNonSilence = true,
                            minTrailingSilence = 1.8f,
                            minUtteranceLength = 0.0f,
                        ),
                        // Safety boundary for a very long stream. IMPORTANT:
                        // mustContainNonSilence=true prevents pure silence from permanently
                        // latching endpoint=true after 20 seconds.
                        rule3 = EndpointRule(
                            mustContainNonSilence = true,
                            minTrailingSilence = 0.0f,
                            minUtteranceLength = 20.0f,
                        ),
                    )

                val config =
                    OnlineRecognizerConfig(
                        modelConfig = modelConfig,
                        endpointConfig = endpointConfig,
                        enableEndpoint = true,
                        decodingMethod = "greedy_search",
                    )

                Log.i(TAG, "★★★★★ CREATING OnlineRecognizer ★★★★★")

                recognizer = OnlineRecognizer(assetManager = null, config = config)

                Log.i(TAG, "★★★★★ OnlineRecognizer CREATED ★★★★★")

                stream =
                    recognizer!!.createStream().also {
                        Log.i(TAG, "★★★★★ SET STREAM LANGUAGE=$language ★★★★★")

                        it.setOption("language", language)
                    }

                lastText = ""
                endpointLatched = false
                endpointResetCount = 0L

                pcmChunkCount = 0L
                totalPcmBytes = 0L
                totalSamples = 0L
                decodeCount = 0L
                resultCheckCount = 0L

                synchronized(timingLock) {
                    submittedChunkCount = 0L
                    completedChunkCount = 0L
                    queuedChunkCount = 0L
                    maxQueuedChunkCount = 0L
                    maxEnqueueDelayMs = 0.0
                    totalProcessingMs = 0.0
                    totalDecodeMs = 0.0
                    totalAcceptedAudioMs = 0.0
                    timingStartedNs = System.nanoTime()
                }

                Log.i(
                    TAG,
                    "★★★★★ SHERPA READY language=$language " + "model=${dir.absolutePath} ★★★★★",
                )

                listener.onSherpaReady(language)
            } catch (e: Exception) {

                running = false

                Log.e(TAG, "★★★★★ SHERPA START FAILED: ${e.message} ★★★★★", e)

                listener.onSherpaError(e.message ?: "Sherpa start failed")
            }
        }
    }

    // ============================================================
    // PCM INPUT
    // ============================================================

    fun acceptPcm16(bytes: ByteArray) {

        if (!running) {

            Log.w(TAG, "★★★★★ PCM IGNORED: recognizer not running bytes=${bytes.size} ★★★★★")

            return
        }

        if (bytes.isEmpty()) {

            Log.w(TAG, "★★★★★ PCM IGNORED: empty chunk ★★★★★")

            return
        }

        val copy = bytes.copyOf()
        val enqueuedNs = System.nanoTime()
        val audioDurationMs = (copy.size / 2.0) * 1000.0 / SAMPLE_RATE

        val submittedId: Long
        val queueDepthAtSubmit: Long
        synchronized(timingLock) {
            submittedChunkCount++
            submittedId = submittedChunkCount
            queuedChunkCount++
            queueDepthAtSubmit = queuedChunkCount
            if (queuedChunkCount > maxQueuedChunkCount) {
                maxQueuedChunkCount = queuedChunkCount
            }
        }

        executor.execute {
            val taskStartedNs = System.nanoTime()
            val enqueueDelayMs = (taskStartedNs - enqueuedNs) / 1_000_000.0
            var decodeMs = 0.0
            var decodedThisChunk = 0

            synchronized(timingLock) {
                if (enqueueDelayMs > maxEnqueueDelayMs) {
                    maxEnqueueDelayMs = enqueueDelayMs
                }
            }
            if (!running) {
                Log.w(TAG, "★★★★★ PCM DROPPED IN EXECUTOR: stopped ★★★★★")
                return@execute
            }

            try {

                val r = recognizer

                if (r == null) {

                    Log.e(TAG, "★★★★★ PCM RECEIVED BUT recognizer=NULL ★★★★★")

                    return@execute
                }

                val s = stream

                if (s == null) {

                    Log.e(TAG, "★★★★★ PCM RECEIVED BUT stream=NULL ★★★★★")

                    return@execute
                }

                pcmChunkCount++
                totalPcmBytes += copy.size

                val samples = pcm16LeToFloat(copy)

                totalSamples += samples.size

                // Signal diagnostics on the exact 16 kHz float PCM given to Sherpa.
                var peak = 0.0f
                var sumAbs = 0.0
                var sumSquares = 0.0

                for (sample in samples) {

                    val amplitude = abs(sample)

                    if (amplitude > peak) {
                        peak = amplitude
                    }

                    sumAbs += amplitude
                    sumSquares += sample.toDouble() * sample.toDouble()
                }

                val avgAbs =
                    if (samples.isNotEmpty()) {
                        sumAbs / samples.size
                    } else {
                        0.0
                    }

                val rms =
                    if (samples.isNotEmpty()) {
                        sqrt(sumSquares / samples.size).toFloat()
                    } else {
                        0.0f
                    }

                val speechLike =
                    rms >= SPEECH_RMS_LOG_THRESHOLD ||
                        peak >= SPEECH_PEAK_LOG_THRESHOLD

                /*
                 * Log first 10 chunks, then every 10th chunk.
                 *
                 * 3200 bytes = 1600 PCM16 samples
                 * at 16 kHz = 100 ms of audio.
                 */
                if (pcmChunkCount <= 10L || pcmChunkCount % 10L == 0L) {

                    Log.i(
                        TAG,
                        "★★★★★ SHERPA PCM " +
                            "chunk=$pcmChunkCount " +
                            "bytes=${copy.size} " +
                            "samples=${samples.size} " +
                            "totalSamples=$totalSamples " +
                            "peak=$peak " +
                            "avgAbs=$avgAbs " +
                            "rms=$rms ★★★★★",
                    )
                }

                if (speechLike) {
                    Log.i(
                        TAG,
                        "★★★★★ SPEECH_PCM " +
                            "chunk=$pcmChunkCount " +
                            "peak=$peak " +
                            "rms=$rms " +
                            "avgAbs=$avgAbs " +
                            "samples=${samples.size} ★★★★★",
                    )
                }

                // ------------------------------------------------
                // FEED AUDIO TO SHERPA
                // ------------------------------------------------

                s.acceptWaveform(samples, SAMPLE_RATE)

                if (pcmChunkCount <= 10L || pcmChunkCount % 10L == 0L) {

                    Log.i(TAG, "★★★★★ ACCEPT_WAVEFORM OK chunk=$pcmChunkCount ★★★★★")
                }

                // ------------------------------------------------
                // DECODE EVERYTHING CURRENTLY READY
                // ------------------------------------------------

                val decodeStartedNs = System.nanoTime()

                while (r.isReady(s)) {

                    r.decode(s)

                    decodeCount++
                    decodedThisChunk++
                }

                decodeMs = (System.nanoTime() - decodeStartedNs) / 1_000_000.0

                if (pcmChunkCount <= 10L || pcmChunkCount % 10L == 0L || decodedThisChunk > 0) {

                    Log.i(
                        TAG,
                        "★★★★★ DECODE chunk=$pcmChunkCount " +
                            "decodedThisChunk=$decodedThisChunk " +
                            "totalDecode=$decodeCount ★★★★★",
                    )
                }

                // ------------------------------------------------
                // READ CURRENT RESULT
                // ------------------------------------------------

                val result = r.getResult(s)

                resultCheckCount++

                val text = result.text.trim()

                if (pcmChunkCount <= 10L || pcmChunkCount % 10L == 0L || text.isNotEmpty()) {

                    Log.i(
                        TAG,
                        "★★★★★ RESULT chunk=$pcmChunkCount " +
                            "check=$resultCheckCount " +
                            "text='$text' ★★★★★",
                    )
                }

                // ------------------------------------------------
                // PARTIAL RESULT
                // ------------------------------------------------

                if (text.isNotEmpty() && text != lastText) {

                    Log.i(TAG, "★★★★★ PARTIAL language=$language text='$text' ★★★★★")

                    lastText = text

                    listener.onSherpaPartial(text, language)
                }

                // ------------------------------------------------
                // ENDPOINT / FINAL RESULT
                // ------------------------------------------------

                val endpoint = r.isEndpoint(s)

                if (speechLike || decodedThisChunk > 0 || text.isNotEmpty() || endpoint) {
                    Log.i(
                        TAG,
                        "★★★★★ RECO_DIAG " +
                            "chunk=$pcmChunkCount " +
                            "peak=$peak " +
                            "rms=$rms " +
                            "speechLike=$speechLike " +
                            "decodedThisChunk=$decodedThisChunk " +
                            "text='$text' " +
                            "endpoint=$endpoint ★★★★★",
                    )
                }

                if (!endpoint) {
                    endpointLatched = false
                } else if (!endpointLatched) {
                    endpointLatched = true

                    Log.i(TAG, "★★★★★ ENDPOINT EDGE text='$text' chunk=$pcmChunkCount ★★★★★")

                    if (text.isNotEmpty()) {
                        Log.i(TAG, "★★★★★ FINAL language=$language text='$text' ★★★★★")
                        listener.onSherpaFinal(text, language)

                        r.reset(s)
                        s.setOption("language", language)
                        lastText = ""
                        endpointLatched = false
                        endpointResetCount++

                        Log.i(
                            TAG,
                            "★★★★★ STREAM RESET reason=final " +
                                "count=$endpointResetCount language=$language ★★★★★",
                        )
                    } else {
                        // Do not reset on the first empty endpoint edge. A very short
                        // utterance can still need another decode cycle. Unlike the old
                        // code, however, we also do not log/process the same latched
                        // endpoint on every following 100 ms chunk.
                        Log.i(
                            TAG,
                            "★★★★★ EMPTY ENDPOINT EDGE - WAITING FOR MORE AUDIO " +
                                "chunk=$pcmChunkCount ★★★★★",
                        )
                    }
                }
            } catch (e: Exception) {

                Log.e(TAG, "★★★★★ SHERPA DECODE FAILED: ${e.message} ★★★★★", e)

                listener.onSherpaError(e.message ?: "Sherpa decode failed")
            } finally {
                val processingMs = (System.nanoTime() - taskStartedNs) / 1_000_000.0

                val completed: Long
                val queueRemaining: Long
                val maxQueue: Long
                val maxDelay: Double
                val avgProcessing: Double
                val avgDecode: Double
                val realtimeFactor: Double
                val totalAudio: Double

                synchronized(timingLock) {
                    completedChunkCount++
                    if (queuedChunkCount > 0L) {
                        queuedChunkCount--
                    }
                    totalProcessingMs += processingMs
                    totalDecodeMs += decodeMs
                    totalAcceptedAudioMs += audioDurationMs

                    completed = completedChunkCount
                    queueRemaining = queuedChunkCount
                    maxQueue = maxQueuedChunkCount
                    maxDelay = maxEnqueueDelayMs
                    avgProcessing =
                        if (completedChunkCount > 0L) totalProcessingMs / completedChunkCount else 0.0
                    avgDecode =
                        if (completedChunkCount > 0L) totalDecodeMs / completedChunkCount else 0.0
                    totalAudio = totalAcceptedAudioMs
                    realtimeFactor =
                        if (totalAcceptedAudioMs > 0.0) totalProcessingMs / totalAcceptedAudioMs else 0.0
                }

                if (
                    submittedId <= 20L ||
                    submittedId % 10L == 0L ||
                    enqueueDelayMs >= 100.0 ||
                    processingMs >= audioDurationMs ||
                    queueDepthAtSubmit > 2L
                ) {
                    Log.i(
                        TAG,
                        "★★★★★ SHERPA_SPEED " +
                            "chunk=$submittedId " +
                            "audioMs=${"%.1f".format(audioDurationMs)} " +
                            "enqueueDelayMs=${"%.1f".format(enqueueDelayMs)} " +
                            "processMs=${"%.1f".format(processingMs)} " +
                            "decodeMs=${"%.1f".format(decodeMs)} " +
                            "decoded=$decodedThisChunk " +
                            "queueAtSubmit=$queueDepthAtSubmit " +
                            "queueRemaining=$queueRemaining " +
                            "maxQueue=$maxQueue " +
                            "maxDelayMs=${"%.1f".format(maxDelay)} " +
                            "avgProcessMs=${"%.1f".format(avgProcessing)} " +
                            "avgDecodeMs=${"%.1f".format(avgDecode)} " +
                            "totalAudioMs=${"%.1f".format(totalAudio)} " +
                            "RTF=${"%.3f".format(realtimeFactor)} ★★★★★",
                    )
                }
            }
        }
    }

    // ============================================================
    // STOP
    // ============================================================

    fun stop() {

        Log.i(
            TAG,
            "★★★★★ STOP requested " +
                "chunks=$pcmChunkCount " +
                "bytes=$totalPcmBytes " +
                "samples=$totalSamples " +
                "decodes=$decodeCount ★★★★★",
        )

        running = false

        executor.execute { releaseInternal() }
    }

    // ============================================================
    // RELEASE
    // ============================================================

    fun release() {

        Log.i(TAG, "★★★★★ RELEASE requested ★★★★★")

        running = false

        executor.execute { releaseInternal() }

        executor.shutdown()
    }

    // ============================================================
    // INTERNAL RELEASE
    // ============================================================

    private fun releaseInternal() {

        Log.i(
            TAG,
            "★★★★★ RELEASE INTERNAL " +
                "chunks=$pcmChunkCount " +
                "bytes=$totalPcmBytes " +
                "samples=$totalSamples " +
                "decodes=$decodeCount ★★★★★",
        )

        try {
            stream?.release()
        } catch (e: Exception) {
            Log.w(TAG, "Stream release failed: ${e.message}")
        }

        try {
            recognizer?.release()
        } catch (e: Exception) {
            Log.w(TAG, "Recognizer release failed: ${e.message}")
        }

        stream = null
        recognizer = null
        lastText = ""
        endpointLatched = false
    }

    // ============================================================
    // PCM16 LITTLE-ENDIAN -> FLOAT [-1, 1]
    // ============================================================

    private fun pcm16LeToFloat(bytes: ByteArray): FloatArray {

        val count = bytes.size / 2
        val result = FloatArray(count)

        var j = 0

        for (i in 0 until count) {

            val lo = bytes[j].toInt() and 0xff

            val hi = bytes[j + 1].toInt()

            val sample = (hi shl 8) or lo

            result[i] = sample.toShort() / 32768.0f

            j += 2
        }

        return result
    }

    // ============================================================
    // LANGUAGE
    // ============================================================

    private fun toSherpaLanguage(locale: String): String {

        if (locale.equals("auto", true)) {
            return "auto"
        }

        return when (locale.lowercase()) {
            "en-us",
            "en-gb",
            "en" -> "en"

            "de-de",
            "de" -> "de"

            "es-es",
            "es-us",
            "es" -> "es"

            "fr-fr",
            "fr-ca",
            "fr" -> "fr"

            "it-it",
            "it" -> "it"

            "pt-pt",
            "pt-br",
            "pt" -> "pt"

            "ar-ar",
            "ar" -> "ar"

            "ru-ru",
            "ru" -> "ru"

            "hr-hr",
            "hr" -> "hr"

            else -> locale.substringBefore('-').lowercase()
        }
    }
}
