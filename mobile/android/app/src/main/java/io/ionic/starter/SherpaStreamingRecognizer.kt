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
                        // Rule 1 fires even when no speech was decoded. The default 2.4 s
                        // caused repeated empty endpoints during silence. Keep it only as
                        // a long safety boundary; normal utterances are finalized by rule 2.
                        rule1 = EndpointRule(
                            mustContainNonSilence = false,
                            minTrailingSilence = 30.0f,
                            minUtteranceLength = 0.0f,
                        ),
                        // After real speech has been decoded, allow a little more trailing
                        // silence than the default. This gives 1-3 word utterances enough
                        // time to become a stable hypothesis before reset.
                        rule2 = EndpointRule(
                            mustContainNonSilence = true,
                            minTrailingSilence = 1.8f,
                            minUtteranceLength = 0.0f,
                        ),
                        rule3 = EndpointRule(
                            mustContainNonSilence = false,
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

                // Calculate simple signal diagnostics.
                var peak = 0.0f
                var sumAbs = 0.0

                for (sample in samples) {

                    val amplitude = abs(sample)

                    if (amplitude > peak) {
                        peak = amplitude
                    }

                    sumAbs += amplitude
                }

                val avgAbs =
                    if (samples.isNotEmpty()) {
                        sumAbs / samples.size
                    } else {
                        0.0
                    }

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
                            "avgAbs=$avgAbs ★★★★★",
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

                if (endpoint) {

                    Log.i(TAG, "★★★★★ ENDPOINT DETECTED text='$text' ★★★★★")

                    // Never destroy the active stream on an empty endpoint. With short
                    // utterances the acoustic model may need another decode cycle before
                    // text becomes available. Reset only after we have an actual result.
                    if (text.isEmpty()) {
                        Log.i(TAG, "★★★★★ EMPTY ENDPOINT IGNORED - STREAM KEPT ALIVE ★★★★★")
                        return@execute
                    }

                    Log.i(TAG, "★★★★★ FINAL language=$language text='$text' ★★★★★")
                    listener.onSherpaFinal(text, language)

                    r.reset(s)
                    s.setOption("language", language)
                    lastText = ""

                    Log.i(TAG, "★★★★★ STREAM RESET language=$language ★★★★★")
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
