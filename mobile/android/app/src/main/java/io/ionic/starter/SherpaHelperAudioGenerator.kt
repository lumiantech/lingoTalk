package io.ionic.starter

import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.util.Log
import java.io.File
import java.util.Locale

object SherpaHelperAudioGenerator {

    private const val TAG = "SherpaHelperAudio"

    fun generate(context: Context) {

        lateinit var tts: TextToSpeech

        tts = TextToSpeech(context) { status ->

            if (status != TextToSpeech.SUCCESS) {
                Log.e(TAG, "TTS initialization failed: $status")
                return@TextToSpeech
            }

            val languageResult = tts.setLanguage(Locale.US)

            if (
                languageResult == TextToSpeech.LANG_MISSING_DATA ||
                languageResult == TextToSpeech.LANG_NOT_SUPPORTED
            ) {
                Log.e(TAG, "English US TTS is not available")
                tts.shutdown()
                return@TextToSpeech
            }

            tts.setSpeechRate(1.0f)
            tts.setPitch(1.0f)

            val outputFile = File(
                context.getExternalFilesDir(null),
                "zebra-coffee-window.wav"
            )

            val params = Bundle()

            val result = tts.synthesizeToFile(
                "zebra coffee window",
                params,
                outputFile,
                "sherpa-helper-audio"
            )

            Log.i(
                TAG,
                "synthesizeToFile result=$result file=${outputFile.absolutePath}"
            )
        }
    }
}