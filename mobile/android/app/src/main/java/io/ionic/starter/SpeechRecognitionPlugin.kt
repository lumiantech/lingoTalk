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
import android.util.Base64
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "SpeechRecognition")
class SpeechRecognitionPlugin : Plugin() {

    companion object {
        private const val TAG = "LingoSpeech"

        // How long we give an Android 12 RecognitionService
        // to open EXTRA_AUDIO_INJECT_SOURCE.
        private const val SERVICE_TEST_DELAY_MS = 1500L
    }

    private var speechRecognizer: SpeechRecognizer? = null

    private val handler = Handler(Looper.getMainLooper())

    private var keepListening = false

    private var language = "hr-HR"

    private val restartRunnable = Runnable { startRecognizer() }

    // ============================================================
    // ANDROID 12 RECOGNITION SERVICE TEST
    // ============================================================

    private data class RecognitionServiceCandidate(
        val label: String,
        val packageName: String,
        val className: String,
    )

    /*
     * These are the three RecognitionService implementations that
     * were actually found on the Samsung S10e.
     *
     * We test them in this order:
     *
     * 0 - Google Voice Search
     * 1 - Google TTS recognition service
     * 2 - Samsung / Bixby
     */
    private val android12RecognitionServices =
        listOf(
            RecognitionServiceCandidate(
                label = "GOOGLE_VOICE_SEARCH",
                packageName = "com.google.android.googlequicksearchbox",
                className = "com.google.android.voicesearch.serviceapi.GoogleRecognitionService",
            ),
            RecognitionServiceCandidate(
                label = "GOOGLE_TTS",
                packageName = "com.google.android.tts",
                className =
                    "com.google.android.apps.speech.tts.googletts.service.GoogleTTSRecognitionService",
            ),
            RecognitionServiceCandidate(
                label = "SAMSUNG_BIXBY",
                packageName = "com.samsung.android.bixby.agent",
                className =
                    "com.samsung.android.bixby.agent.mainui.voiceinteraction.RecognitionServiceTrampoline",
            ),
        )

    private var currentServiceIndex = 0

    private var testingRecognitionServices = false

    private var selectedWorkingService: RecognitionServiceCandidate? = null

    private var serviceTestRunnable: Runnable? = null

    // ============================================================
    // CAPABILITIES
    // ============================================================

    @PluginMethod
    fun getCapabilities(call: PluginCall) {

        val result = JSObject()

        result.put("androidApi", Build.VERSION.SDK_INT)
        result.put("androidVersion", Build.VERSION.RELEASE)
        result.put("audioInjectionMode", getAudioInjectionMode())
        result.put("supportsSharedAudio", Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)

        Log.d(
            TAG,
            "CAPABILITIES api=${Build.VERSION.SDK_INT}, " +
                "android=${Build.VERSION.RELEASE}, " +
                "mode=${getAudioInjectionMode()}",
        )

        call.resolve(result)
    }

    // ============================================================
    // START
    // ============================================================

    @PluginMethod
    fun start(call: PluginCall) {

        language = call.getString("language", "hr-HR") ?: "hr-HR"

        keepListening = true

        Log.d(TAG, "START requested, language=$language")

        activity.runOnUiThread {

            // Diagnostic only.
            logRecognitionServices()

            /*
             * Android 12 / 12L:
             *
             * We explicitly test installed RecognitionService
             * implementations because EXTRA_AUDIO_INJECT_SOURCE
             * is implementation-dependent.
             *
             * Android 13+:
             *
             * We keep using the normal SpeechRecognizer because
             * the audio is supplied directly through
             * EXTRA_AUDIO_SOURCE / ParcelFileDescriptor.
             */
            if (
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                    Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            ) {

                if (selectedWorkingService != null) {

                    Log.d(
                        TAG,
                        "★★★★★ USING PREVIOUSLY SELECTED SERVICE: " +
                            "${selectedWorkingService!!.label} ★★★★★",
                    )

                    createRecognizerForService(selectedWorkingService!!)

                    startRecognizer()
                } else {

                    startRecognitionServiceTest()
                }
            } else {

                ensureRecognizer()

                startRecognizer()
            }

            call.resolve()
        }
    }

    // ============================================================
    // STOP
    // ============================================================

    @PluginMethod
    fun stop(call: PluginCall) {

        Log.d(TAG, "STOP requested")

        keepListening = false

        testingRecognitionServices = false

        handler.removeCallbacks(restartRunnable)

        cancelServiceTestTimer()

        activity.runOnUiThread {
            try {

                speechRecognizer?.stopListening()
            } catch (exception: Exception) {

                Log.d(TAG, "stopListening exception: ${exception.message}")
            }

            try {

                speechRecognizer?.cancel()
            } catch (exception: Exception) {

                Log.d(TAG, "cancel exception: ${exception.message}")
            }

            destroyCurrentRecognizer()

            SharedAudioStream.close()

            sendState("stopped")

            call.resolve()
        }
    }

    // ============================================================
    // PCM FROM ANGULAR / WEBRTC
    // ============================================================

    @PluginMethod
    fun pushAudio(call: PluginCall) {

        val base64 = call.getString("data")

        if (base64 == null) {

            call.reject("Missing audio data")

            return
        }

        try {

            val audioBytes = Base64.decode(base64, Base64.NO_WRAP)

            Log.d(TAG, "pushAudio bytes=${audioBytes.size}")

            SharedAudioStream.write(audioBytes)

            call.resolve()
        } catch (exception: Exception) {

            Log.e(TAG, "pushAudio failed: ${exception.message}", exception)

            call.reject("Failed to push audio", exception)
        }
    }

    // ============================================================
    // RECOGNITION SERVICE DIAGNOSTICS
    // ============================================================

    private fun logRecognitionServices() {

        try {

            val defaultService =
                Settings.Secure.getString(context.contentResolver, "voice_recognition_service")

            Log.d(TAG, "★★★★★ DEFAULT RECOGNITION SERVICE = " + "${defaultService ?: "NONE"} ★★★★★")

            val serviceIntent = Intent(RecognitionService.SERVICE_INTERFACE)

            val services =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {

                    context.packageManager.queryIntentServices(
                        serviceIntent,
                        PackageManager.ResolveInfoFlags.of(
                            PackageManager.MATCH_DEFAULT_ONLY.toLong()
                        ),
                    )
                } else {

                    @Suppress("DEPRECATION")
                    context.packageManager.queryIntentServices(
                        serviceIntent,
                        PackageManager.MATCH_DEFAULT_ONLY,
                    )
                }

            Log.d(TAG, "★★★★★ AVAILABLE RECOGNITION SERVICES = " + "${services.size} ★★★★★")

            services.forEachIndexed { index, resolveInfo ->
                val serviceInfo = resolveInfo.serviceInfo

                Log.d(
                    TAG,
                    "★★★★★ RECOGNITION SERVICE [$index] = " +
                        "${serviceInfo.packageName}/" +
                        "${serviceInfo.name} ★★★★★",
                )
            }
        } catch (exception: Exception) {

            Log.e(TAG, "★★★★★ FAILED TO QUERY RECOGNITION SERVICES ★★★★★", exception)
        }
    }

    // ============================================================
    // ANDROID 12 SERVICE TEST
    // ============================================================

    private fun startRecognitionServiceTest() {

        if (!keepListening) {

            return
        }

        testingRecognitionServices = true

        currentServiceIndex = 0

        Log.d(TAG, "============================================================")

        Log.d(TAG, "★★★★★ STARTING ANDROID 12 RECOGNITION SERVICE TEST ★★★★★")

        Log.d(TAG, "★★★★★ SERVICES TO TEST = " + "${android12RecognitionServices.size} ★★★★★")

        Log.d(TAG, "============================================================")

        testCurrentRecognitionService()
    }

    private fun testCurrentRecognitionService() {

        if (!keepListening) {

            return
        }

        if (!testingRecognitionServices) {

            return
        }

        if (currentServiceIndex >= android12RecognitionServices.size) {

            Log.e(TAG, "============================================================")

            Log.e(TAG, "★★★★★ ALL RECOGNITION SERVICES TESTED ★★★★★")

            Log.e(
                TAG,
                "★★★★★ NO SERVICE HAS YET BEEN CONFIRMED " + "FOR API 31 AUDIO INJECTION ★★★★★",
            )

            Log.e(TAG, "============================================================")

            testingRecognitionServices = false

            sendState("recognition_service_test_failed")

            return
        }

        val candidate = android12RecognitionServices[currentServiceIndex]

        Log.d(TAG, "============================================================")

        Log.d(
            TAG,
            "★★★★★ TESTING SERVICE " +
                "${currentServiceIndex + 1}/" +
                "${android12RecognitionServices.size} ★★★★★",
        )

        Log.d(TAG, "★★★★★ LABEL = ${candidate.label} ★★★★★")

        Log.d(
            TAG,
            "★★★★★ COMPONENT = " + "${candidate.packageName}/" + "${candidate.className} ★★★★★",
        )

        Log.d(TAG, "============================================================")

        cancelServiceTestTimer()

        destroyCurrentRecognizer()

        SharedAudioStream.close()

        createRecognizerForService(candidate)

        if (speechRecognizer == null) {

            Log.e(TAG, "★★★★★ FAILED TO CREATE ${candidate.label} ★★★★★")

            moveToNextRecognitionService()

            return
        }

        startRecognizer()

        /*
         * We give the service a short period in which to consume
         * EXTRA_AUDIO_INJECT_SOURCE and therefore call our
         * SharedAudioProvider.openFile().
         *
         * SharedAudioStream will tell us whether the pipe became
         * writable.
         */
        val runnable = Runnable { checkCurrentRecognitionService() }

        serviceTestRunnable = runnable

        handler.postDelayed(runnable, SERVICE_TEST_DELAY_MS)
    }

    private fun checkCurrentRecognitionService() {

        serviceTestRunnable = null

        if (!keepListening) {

            return
        }

        if (!testingRecognitionServices) {

            return
        }

        val candidate = android12RecognitionServices.getOrNull(currentServiceIndex) ?: return

        val pipeOpen = SharedAudioStream.isOpen()

        if (pipeOpen) {

            selectedWorkingService = candidate

            testingRecognitionServices = false

            Log.d(TAG, "============================================================")

            Log.d(TAG, "★★★★★ SERVICE PASSED ★★★★★")

            Log.d(TAG, "★★★★★ ${candidate.label} OPENED AUDIO PIPE ★★★★★")

            Log.d(
                TAG,
                "★★★★★ COMPONENT = " + "${candidate.packageName}/" + "${candidate.className} ★★★★★",
            )

            Log.d(TAG, "============================================================")

            sendState("recognition_service_selected")

            return
        }

        Log.e(TAG, "============================================================")

        Log.e(TAG, "★★★★★ SERVICE FAILED PIPE TEST ★★★★★")

        Log.e(TAG, "★★★★★ ${candidate.label} DID NOT OPEN AUDIO PIPE ★★★★★")

        Log.e(TAG, "============================================================")

        moveToNextRecognitionService()
    }

    private fun moveToNextRecognitionService() {

        cancelServiceTestTimer()

        try {

            speechRecognizer?.cancel()
        } catch (exception: Exception) {

            Log.d(TAG, "cancel before next service: ${exception.message}")
        }

        destroyCurrentRecognizer()

        SharedAudioStream.close()

        currentServiceIndex++

        handler.postDelayed({ testCurrentRecognitionService() }, 300L)
    }

    private fun cancelServiceTestTimer() {

        serviceTestRunnable?.let { handler.removeCallbacks(it) }

        serviceTestRunnable = null
    }

    // ============================================================
    // CREATE SPECIFIC RECOGNITION SERVICE
    // ============================================================

    private fun createRecognizerForService(candidate: RecognitionServiceCandidate) {

        try {

            val component = ComponentName(candidate.packageName, candidate.className)

            Log.d(TAG, "★★★★★ CREATING RECOGNIZER FOR " + "${candidate.label}: $component ★★★★★")

            speechRecognizer = SpeechRecognizer.createSpeechRecognizer(context, component)

            speechRecognizer?.setRecognitionListener(recognitionListener)

            Log.d(TAG, "★★★★★ RECOGNIZER CREATED FOR " + "${candidate.label} ★★★★★")
        } catch (exception: Exception) {

            Log.e(
                TAG,
                "★★★★★ FAILED TO CREATE RECOGNIZER FOR " + "${candidate.label} ★★★★★",
                exception,
            )

            speechRecognizer = null
        }
    }

    // ============================================================
    // SHARED AUDIO CONFIGURATION
    //
    // Android 13+:
    //      EXTRA_AUDIO_SOURCE
    //
    // Android 12 / 12L:
    //      EXTRA_AUDIO_INJECT_SOURCE
    //
    // ============================================================

    private fun configureSharedAudio(intent: Intent) {

        when {

            // ----------------------------------------------------
            // ANDROID 13+
            // API 33+
            // ----------------------------------------------------

            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> {

                Log.d(TAG, "Using API 33+ EXTRA_AUDIO_SOURCE")

                val audioSource = SharedAudioStream.createPipe()

                intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, audioSource)

                intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)

                intent.putExtra(
                    RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING,
                    AudioFormat.ENCODING_PCM_16BIT,
                )

                intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, 16000)

                Log.d(TAG, "API 33+ audio source configured: " + "PCM16 mono 16000Hz")
            }

            // ----------------------------------------------------
            // ANDROID 12 / 12L
            // API 31–32
            // ----------------------------------------------------

            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {

                val audioUri =
                    Uri.parse("content://" + "${context.packageName}" + ".speech.audio/live")

                Log.d(TAG, "Using API 31 shared audio URI: $audioUri")

                @Suppress("DEPRECATION")
                intent.putExtra(RecognizerIntent.EXTRA_AUDIO_INJECT_SOURCE, audioUri)

                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }

            // ----------------------------------------------------
            // ANDROID 11 AND OLDER
            // ----------------------------------------------------

            else -> {

                Log.d(
                    TAG,
                    "Shared audio injection unsupported " +
                        "on Android API ${Build.VERSION.SDK_INT}",
                )
            }
        }
    }

    // ============================================================
    // CREATE DEFAULT SPEECH RECOGNIZER
    // ============================================================

    private fun ensureRecognizer() {

        if (speechRecognizer != null) {

            Log.d(TAG, "SpeechRecognizer already exists")

            return
        }

        val available = SpeechRecognizer.isRecognitionAvailable(context)

        Log.d(TAG, "Recognition available=$available")

        if (!available) {

            val data = JSObject()

            data.put("message", "Speech recognition is not available.")

            notifyListeners("error", data)

            return
        }

        try {

            speechRecognizer = SpeechRecognizer.createSpeechRecognizer(context)

            speechRecognizer?.setRecognitionListener(recognitionListener)

            Log.d(TAG, "SpeechRecognizer created")
        } catch (exception: Exception) {

            Log.e(TAG, "Failed to create SpeechRecognizer", exception)

            speechRecognizer = null

            val data = JSObject()

            data.put("message", exception.message ?: "Failed to create speech recognizer")

            notifyListeners("error", data)
        }
    }

    // ============================================================
    // DESTROY CURRENT RECOGNIZER
    // ============================================================

    private fun destroyCurrentRecognizer() {

        try {

            speechRecognizer?.cancel()
        } catch (exception: Exception) {

            Log.d(TAG, "cancel during destroy: ${exception.message}")
        }

        try {

            speechRecognizer?.destroy()
        } catch (exception: Exception) {

            Log.d(TAG, "destroyCurrentRecognizer exception: " + "${exception.message}")
        }

        speechRecognizer = null
    }

    // ============================================================
    // RECOGNITION LISTENER
    // ============================================================

    private val recognitionListener =
        object : RecognitionListener {

            override fun onReadyForSpeech(params: Bundle?) {

                Log.d(TAG, "READY FOR SPEECH")

                sendState("ready")
            }

            override fun onBeginningOfSpeech() {

                Log.d(TAG, "BEGINNING OF SPEECH")

                sendState("speaking")
            }

            override fun onRmsChanged(rmsdB: Float) {

                Log.d(TAG, "RMS: $rmsdB")
            }

            override fun onBufferReceived(buffer: ByteArray?) {

                Log.d(TAG, "BUFFER RECEIVED size=${buffer?.size ?: 0}")
            }

            override fun onEndOfSpeech() {

                Log.d(TAG, "END OF SPEECH")

                sendState("processing")
            }

            override fun onError(error: Int) {

                Log.d(TAG, "ERROR $error: ${errorMessage(error)}")

                val data = JSObject()

                data.put("code", error)

                data.put("message", errorMessage(error))

                notifyListeners("error", data)

                if (!keepListening) {

                    return
                }

                /*
                 * While we are testing Android 12 services,
                 * the service-test controller owns the transition
                 * to the next recognizer.
                 *
                 * Do NOT start the normal restart loop here.
                 */
                if (testingRecognitionServices) {

                    Log.d(
                        TAG,
                        "Error occurred during RecognitionService test; " +
                            "waiting for pipe-test decision",
                    )

                    return
                }

                val delay =
                    if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) {

                        1000L
                    } else {

                        300L
                    }

                Log.d(TAG, "Restart after error in ${delay}ms")

                restartAfter(delay)
            }

            override fun onResults(results: Bundle?) {

                val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)

                Log.d(TAG, "RESULTS: $matches")

                if (!matches.isNullOrEmpty()) {

                    val data = JSObject()

                    data.put("text", matches[0])

                    notifyListeners("finalResult", data)
                }

                if (!keepListening) {

                    return
                }

                if (testingRecognitionServices) {

                    Log.d(TAG, "Result received during RecognitionService test")

                    return
                }

                Log.d(TAG, "Restart after final result")

                restartAfter(250L)
            }

            override fun onPartialResults(partialResults: Bundle?) {

                val matches =
                    partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)

                Log.d(TAG, "PARTIAL: $matches")

                if (matches.isNullOrEmpty()) {

                    return
                }

                val data = JSObject()

                data.put("text", matches[0])

                notifyListeners("partialResult", data)
            }

            override fun onEvent(eventType: Int, params: Bundle?) {

                Log.d(TAG, "EVENT type=$eventType")
            }
        }

    // ============================================================
    // START RECOGNIZER
    // ============================================================

    private fun startRecognizer() {

        if (!keepListening) {

            Log.d(TAG, "startRecognizer ignored: keepListening=false")

            return
        }

        val recognizer = speechRecognizer

        if (recognizer == null) {

            Log.d(TAG, "startRecognizer failed: recognizer=null")

            return
        }

        handler.removeCallbacks(restartRunnable)

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)

        intent.putExtra(
            RecognizerIntent.EXTRA_LANGUAGE_MODEL,
            RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
        )

        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)

        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)

        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)

        // Android 12 / Android 13+ shared audio
        configureSharedAudio(intent)

        val serviceLabel =
            selectedWorkingService?.label
                ?: if (
                    testingRecognitionServices &&
                        currentServiceIndex < android12RecognitionServices.size
                ) {

                    android12RecognitionServices[currentServiceIndex].label
                } else {

                    "DEFAULT"
                }

        Log.d(
            TAG,
            "Calling startListening(), " +
                "language=$language, " +
                "api=${Build.VERSION.SDK_INT}, " +
                "mode=${getAudioInjectionMode()}, " +
                "service=$serviceLabel",
        )

        try {

            recognizer.startListening(intent)
        } catch (exception: Exception) {

            Log.e(TAG, "startListening exception: ${exception.message}", exception)

            val data = JSObject()

            data.put("message", exception.message ?: "Speech recognition error")

            notifyListeners("error", data)

            if (!keepListening) {

                return
            }

            if (testingRecognitionServices) {

                Log.e(TAG, "startListening failed during service test")

                moveToNextRecognitionService()

                return
            }

            restartAfter(1000L)
        }
    }

    // ============================================================
    // RESTART
    // ============================================================

    private fun restartAfter(milliseconds: Long) {

        handler.removeCallbacks(restartRunnable)

        handler.postDelayed(restartRunnable, milliseconds)
    }

    // ============================================================
    // STATE
    // ============================================================

    private fun sendState(state: String) {

        Log.d(TAG, "STATE: $state")

        val data = JSObject()

        data.put("state", state)

        notifyListeners("stateChanged", data)
    }

    // ============================================================
    // ERROR TEXT
    // ============================================================

    private fun errorMessage(error: Int): String {

        return when (error) {
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
    }

    // ============================================================
    // AUDIO MODE
    // ============================================================

    private fun getAudioInjectionMode(): String {

        return when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> {

                "AUDIO_SOURCE_API_33"
            }

            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {

                "AUDIO_INJECT_SOURCE_API_31"
            }

            else -> {

                "UNSUPPORTED"
            }
        }
    }

    // ============================================================
    // DESTROY
    // ============================================================

    override fun handleOnDestroy() {

        Log.d(TAG, "DESTROY")

        keepListening = false

        testingRecognitionServices = false

        handler.removeCallbacks(restartRunnable)

        cancelServiceTestTimer()

        destroyCurrentRecognizer()

        SharedAudioStream.close()

        super.handleOnDestroy()
    }
}
