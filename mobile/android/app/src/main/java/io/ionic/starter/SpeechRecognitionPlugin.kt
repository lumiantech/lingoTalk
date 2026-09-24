package io.ionic.starter

import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.Executors

@CapacitorPlugin(name = "SpeechRecognition")
class SpeechRecognitionPlugin : Plugin(), SherpaStreamingRecognizer.Listener {
    companion object {
        private const val TAG = "LingoSpeech"
        private const val SERVICE_TEST_DELAY_MS = 1500L
    }

    private data class RecognitionServiceCandidate(
        val label: String,
        val packageName: String,
        val className: String,
    )

    private val android12RecognitionServices =
        listOf(
            RecognitionServiceCandidate(
                "GOOGLE_VOICE_SEARCH",
                "com.google.android.googlequicksearchbox",
                "com.google.android.voicesearch.serviceapi.GoogleRecognitionService",
            ),
            RecognitionServiceCandidate(
                "GOOGLE_TTS",
                "com.google.android.tts",
                "com.google.android.apps.speech.tts.googletts.service.GoogleTTSRecognitionService",
            ),
            RecognitionServiceCandidate(
                "SAMSUNG_BIXBY",
                "com.samsung.android.bixby.agent",
                "com.samsung.android.bixby.agent.mainui.voiceinteraction.RecognitionServiceTrampoline",
            ),
        )

    private val modelInstallerExecutor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private val restartRunnable = Runnable { startGoogleRecognizer() }
    private var speechRecognizer: SpeechRecognizer? = null
    private var sherpa: SherpaStreamingRecognizer? = null
    private var nativeSherpaAudio: NativeSherpaAudioCapture? = null
    private var keepListening = false
    private var language = "hr-HR"
    private var sherpaActive = false
    private var currentServiceIndex = 0
    private var testingRecognitionServices = false
    private var selectedWorkingService: RecognitionServiceCandidate? = null
    private var serviceTestRunnable: Runnable? = null
    private var googleUtteranceId = 1L

    override fun load() {
        sherpa = SherpaStreamingRecognizer(context, this)

        nativeSherpaAudio =
            NativeSherpaAudioCapture(
                context = context,
                onPcm = { bytes ->
                    if (sherpaActive) {
                        sherpa?.acceptPcm16(bytes)
                    }
                },
                onError = { message ->
                    Log.e(TAG, "Native Sherpa microphone error: $message")
                    notifyListeners(
                        "error",
                        JSObject().apply {
                            put("engine", "sherpa")
                            put("message", message)
                        },
                    )
                },
            )
    }

    @PluginMethod
    fun getCapabilities(call: PluginCall) {
        call.resolve(
            JSObject().apply {
                put("androidApi", Build.VERSION.SDK_INT)
                put("androidVersion", Build.VERSION.RELEASE)
                put("audioInjectionMode", getAudioInjectionMode())
                put("supportsSharedAudio", Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                put("sherpaFallback", true)
            }
        )
    }

    @PluginMethod
    fun prepareOfflineModel(call: PluginCall) {

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            call.resolve(
                JSObject().apply {
                    put("installed", false)
                    put("required", false)
                }
            )
            return
        }

        if (SherpaModelInstaller.isInstalled(context)) {

            Log.i(TAG, "★★★★★ OFFLINE MODEL ALREADY READY ★★★★★")

            call.resolve(
                JSObject().apply {
                    put("installed", true)
                    put("required", true)
                }
            )

            return
        }

        Log.i(TAG, "★★★★★ PREPARING OFFLINE MODEL BEFORE CALL ★★★★★")

        sendState("model_installing", "sherpa")

        modelInstallerExecutor.execute {
            try {

                SherpaModelInstaller.ensureInstalled(context) { progress ->
                    Log.i(TAG, "★★★★★ OFFLINE MODEL INSTALL PROGRESS=$progress% ★★★★★")

                    notifyListeners(
                        "modelInstallProgress",
                        JSObject().apply { put("progress", progress) },
                    )
                }

                Log.i(TAG, "★★★★★ OFFLINE MODEL READY ★★★★★")

                sendState("model_ready", "sherpa")

                call.resolve(
                    JSObject().apply {
                        put("installed", true)
                        put("required", true)
                    }
                )
            } catch (e: Exception) {

                Log.e(TAG, "★★★★★ OFFLINE MODEL INSTALL FAILED ★★★★★", e)

                sendState("model_install_failed", "sherpa")

                notifyListeners(
                    "error",
                    JSObject().apply {
                        put("engine", "sherpa")
                        put("message", e.message ?: "Offline model installation failed")
                    },
                )

                call.reject(e.message ?: "Offline model installation failed", e)
            }
        }
    }

    @PluginMethod
    fun start(call: PluginCall) {
        language = call.getString("language", "hr-HR") ?: "hr-HR"
        keepListening = true
        Log.i(TAG, "START language=$language api=${Build.VERSION.SDK_INT}")
        activity.runOnUiThread {
            logRecognitionServices()
            if (Build.VERSION.SDK_INT in Build.VERSION_CODES.S until Build.VERSION_CODES.TIRAMISU) {
                // Android 12/12L: Sherpa is the reliable PCM path. Google URI injection remains in
                // parallel as a diagnostic/bonus path.
                startSherpa()
                if (selectedWorkingService != null) {
                    createRecognizerForService(selectedWorkingService!!)
                    startGoogleRecognizer()
                } else {
                    startRecognitionServiceTest()
                }
            } else {
                // Android 13+: Google EXTRA_AUDIO_SOURCE first. Sherpa starts only if Google fails.
                ensureRecognizer()
                startGoogleRecognizer()
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        keepListening = false
        testingRecognitionServices = false
        handler.removeCallbacks(restartRunnable)
        cancelServiceTestTimer()
        sherpaActive = false
        nativeSherpaAudio?.stop()
        sherpa?.stop()
        activity.runOnUiThread {
            try {
                speechRecognizer?.stopListening()
            } catch (_: Exception) {}
            try {
                speechRecognizer?.cancel()
            } catch (_: Exception) {}
            destroyCurrentRecognizer()
            SharedAudioStream.close()
            sendState("stopped", "none")
            call.resolve()
        }
    }

    private fun startSherpa() {
        if (sherpaActive) return
        sherpaActive = true
        sendState("sherpa_starting", "sherpa")
        sherpa?.start(language)
    }

    override fun onSherpaReady(language: String) {
        Log.i(TAG, "★★★★★ SHERPA READY -> START NATIVE STT MICROPHONE ★★★★★")
        nativeSherpaAudio?.start()
        sendState("ready", "sherpa")
    }

    override fun onSherpaPartial(text: String, language: String, utteranceId: Long) {
        emitResult("partialResult", text, "sherpa", language, false, utteranceId)
    }

    override fun onSherpaFinal(text: String, language: String, utteranceId: Long) {
        emitResult("finalResult", text, "sherpa", language, true, utteranceId)
    }

    override fun onSherpaError(message: String) {
        sherpaActive = false
        nativeSherpaAudio?.stop()
        notifyListeners(
            "error",
            JSObject().apply {
                put("engine", "sherpa")
                put("message", message)
            },
        )
        sendState("sherpa_unavailable", "sherpa")
    }

    private fun emitResult(
        event: String,
        text: String,
        engine: String,
        resultLanguage: String,
        isFinal: Boolean,
        utteranceId: Long = 0L,
    ) {
        if (text.isBlank()) return
        notifyListeners(
            event,
            JSObject().apply {
                put("text", text)
                put("engine", engine)
                put("language", resultLanguage)
                put("isFinal", isFinal)
                put("utteranceId", utteranceId)
            },
        )
    }

    private fun startRecognitionServiceTest() {
        if (!keepListening) return
        testingRecognitionServices = true
        currentServiceIndex = 0
        Log.i(TAG, "Starting API31/32 RecognitionService pipe test")
        testCurrentRecognitionService()
    }

    private fun testCurrentRecognitionService() {
        if (!keepListening || !testingRecognitionServices) return
        if (currentServiceIndex >= android12RecognitionServices.size) {
            testingRecognitionServices = false
            sendState("recognition_service_test_failed", "google")
            Log.w(
                TAG,
                "No API31/32 RecognitionService opened the shared-audio pipe; Sherpa remains active",
            )
            return
        }
        val candidate = android12RecognitionServices[currentServiceIndex]
        cancelServiceTestTimer()
        destroyCurrentRecognizer()
        SharedAudioStream.close()
        createRecognizerForService(candidate)
        if (speechRecognizer == null) return moveToNextRecognitionService()
        startGoogleRecognizer()
        serviceTestRunnable =
            Runnable { checkCurrentRecognitionService() }
                .also { handler.postDelayed(it, SERVICE_TEST_DELAY_MS) }
    }

    private fun checkCurrentRecognitionService() {
        serviceTestRunnable = null
        if (!keepListening || !testingRecognitionServices) return
        val candidate = android12RecognitionServices.getOrNull(currentServiceIndex) ?: return
        if (SharedAudioStream.isOpen()) {
            selectedWorkingService = candidate
            testingRecognitionServices = false
            Log.i(TAG, "API31/32 service ${candidate.label} opened audio pipe")
            sendState("recognition_service_selected", "google")
        } else {
            Log.w(TAG, "API31/32 service ${candidate.label} did not open audio pipe")
            moveToNextRecognitionService()
        }
    }

    private fun moveToNextRecognitionService() {
        cancelServiceTestTimer()
        try {
            speechRecognizer?.cancel()
        } catch (_: Exception) {}
        destroyCurrentRecognizer()
        SharedAudioStream.close()
        currentServiceIndex++
        handler.postDelayed({ testCurrentRecognitionService() }, 300L)
    }

    private fun cancelServiceTestTimer() {
        serviceTestRunnable?.let(handler::removeCallbacks)
        serviceTestRunnable = null
    }

    private fun createRecognizerForService(candidate: RecognitionServiceCandidate) {
        try {
            val component = ComponentName(candidate.packageName, candidate.className)
            speechRecognizer =
                SpeechRecognizer.createSpeechRecognizer(context, component).also {
                    it.setRecognitionListener(recognitionListener)
                }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to create ${candidate.label}", e)
            speechRecognizer = null
        }
    }

    private fun ensureRecognizer() {
        if (speechRecognizer != null) return
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            notifyListeners(
                "error",
                JSObject().apply {
                    put("engine", "google")
                    put("message", "Speech recognition is not available")
                },
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) startSherpa()
            return
        }
        try {
            speechRecognizer =
                SpeechRecognizer.createSpeechRecognizer(context).also {
                    it.setRecognitionListener(recognitionListener)
                }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to create SpeechRecognizer", e)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) startSherpa()
        }
    }

    private fun configureSharedAudio(intent: Intent) {
        when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> {
                val audioSource = SharedAudioStream.createPipe()
                intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, audioSource)
                intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                intent.putExtra(
                    RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING,
                    AudioFormat.ENCODING_PCM_16BIT,
                )
                intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, 16000)
            }
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
                val uri = Uri.parse("content://${context.packageName}.speech.audio/live")
                @Suppress("DEPRECATION")
                intent.putExtra(RecognizerIntent.EXTRA_AUDIO_INJECT_SOURCE, uri)
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        }
    }

    private val recognitionListener =
        object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) = sendState("ready", "google")

            override fun onBeginningOfSpeech() = sendState("speaking", "google")

            override fun onRmsChanged(rmsdB: Float) {}

            override fun onBufferReceived(buffer: ByteArray?) {}

            override fun onEndOfSpeech() = sendState("processing", "google")

            override fun onError(error: Int) {
                Log.w(TAG, "Google error $error: ${errorMessage(error)}")
                notifyListeners(
                    "error",
                    JSObject().apply {
                        put("engine", "google")
                        put("code", error)
                        put("message", errorMessage(error))
                    },
                )
                if (!keepListening || testingRecognitionServices) return

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    // Once API33+ Google fails, keep the same WebRTC PCM source and move to Sherpa.
                    try {
                        speechRecognizer?.cancel()
                    } catch (_: Exception) {}
                    destroyCurrentRecognizer()
                    SharedAudioStream.close()
                    startSherpa()
                    return
                }
                restartAfter(if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) 1000L else 300L)
            }

            override fun onResults(results: Bundle?) {
                val text =
                    results
                        ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        ?.firstOrNull()
                        .orEmpty()
                if (text.isNotBlank()) {
                    emitResult("finalResult", text, "google", language, true, googleUtteranceId)
                    googleUtteranceId++
                }
                if (keepListening && !testingRecognitionServices && !sherpaActive)
                    restartAfter(250L)
            }

            override fun onPartialResults(partialResults: Bundle?) {
                val text =
                    partialResults
                        ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        ?.firstOrNull()
                        .orEmpty()
                if (text.isNotBlank()) emitResult("partialResult", text, "google", language, false, googleUtteranceId)
            }

            override fun onEvent(eventType: Int, params: Bundle?) {}
        }

    private fun startGoogleRecognizer() {
        if (!keepListening) return
        val recognizer = speechRecognizer ?: return
        handler.removeCallbacks(restartRunnable)
        val intent =
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(
                    RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                    RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
                )
                if (!language.equals("auto", true))
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            }
        configureSharedAudio(intent)
        try {
            recognizer.startListening(intent)
        } catch (e: Exception) {
            Log.e(TAG, "Google startListening failed", e)
            if (testingRecognitionServices) moveToNextRecognitionService()
            else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) startSherpa()
            else restartAfter(1000L)
        }
    }

    private fun restartAfter(ms: Long) {
        handler.removeCallbacks(restartRunnable)
        handler.postDelayed(restartRunnable, ms)
    }

    private fun destroyCurrentRecognizer() {
        try {
            speechRecognizer?.cancel()
        } catch (_: Exception) {}
        try {
            speechRecognizer?.destroy()
        } catch (_: Exception) {}
        speechRecognizer = null
    }

    private fun sendState(state: String, engine: String) {
        notifyListeners(
            "stateChanged",
            JSObject().apply {
                put("state", state)
                put("engine", engine)
            },
        )
    }

    private fun errorMessage(error: Int) =
        when (error) {
            SpeechRecognizer.ERROR_AUDIO -> "Audio recording error"
            SpeechRecognizer.ERROR_CLIENT -> "Client error"
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission missing"
            SpeechRecognizer.ERROR_NETWORK -> "Network error"
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Network timeout"
            SpeechRecognizer.ERROR_NO_MATCH -> "No speech match"
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Speech recognizer busy"
            SpeechRecognizer.ERROR_SERVER -> "Speech recognition server error"
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech detected"
            else -> "Speech recognition error $error"
        }

    private fun getAudioInjectionMode() =
        when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> "AUDIO_SOURCE_API_33"
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> "AUDIO_INJECT_SOURCE_API_31"
            else -> "UNSUPPORTED"
        }

    private fun logRecognitionServices() {
        try {
            val defaultService =
                Settings.Secure.getString(context.contentResolver, "voice_recognition_service")
            Log.d(TAG, "Default recognition service=${defaultService ?: "NONE"}")
            val intent = Intent(RecognitionService.SERVICE_INTERFACE)
            val services =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    context.packageManager.queryIntentServices(
                        intent,
                        PackageManager.ResolveInfoFlags.of(
                            PackageManager.MATCH_DEFAULT_ONLY.toLong()
                        ),
                    )
                } else {
                    @Suppress("DEPRECATION")
                    context.packageManager.queryIntentServices(
                        intent,
                        PackageManager.MATCH_DEFAULT_ONLY,
                    )
                }
            services.forEach {
                Log.d(
                    TAG,
                    "Recognition service=${it.serviceInfo.packageName}/${it.serviceInfo.name}",
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to query recognition services", e)
        }
    }

    override fun handleOnDestroy() {
        keepListening = false
        testingRecognitionServices = false
        handler.removeCallbacks(restartRunnable)
        cancelServiceTestTimer()
        destroyCurrentRecognizer()
        SharedAudioStream.close()
        nativeSherpaAudio?.stop()
        nativeSherpaAudio = null
        sherpa?.release()
        sherpa = null
        modelInstallerExecutor.shutdownNow()
        super.handleOnDestroy()
    }
}
