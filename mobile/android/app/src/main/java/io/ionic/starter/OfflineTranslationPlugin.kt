package io.ionic.starter

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.nl.translate.TranslateLanguage
import com.google.mlkit.nl.translate.Translation
import com.google.mlkit.nl.translate.Translator
import com.google.mlkit.nl.translate.TranslatorOptions

@CapacitorPlugin(name = "OfflineTranslation")
class OfflineTranslationPlugin : Plugin() {

    private var translator: Translator? = null
    private var currentSource: String? = null
    private var currentTarget: String? = null

    @PluginMethod
    fun translate(call: PluginCall) {

        val text = call.getString("text")?.trim().orEmpty()

        val sourceLocale = call.getString("sourceLanguage").orEmpty()

        val targetLocale = call.getString("targetLanguage").orEmpty()

        if (text.isBlank()) {
            call.reject("Text is empty.")
            return
        }

        val source = toMlKitLanguage(sourceLocale)

        val target = toMlKitLanguage(targetLocale)

        if (source == null) {
            call.reject("Unsupported source language: $sourceLocale")
            return
        }

        if (target == null) {
            call.reject("Unsupported target language: $targetLocale")
            return
        }

        if (source == target) {

            call.resolve(
                JSObject().apply {
                    put("originalText", text)
                    put("translatedText", text)
                    put("sourceLanguage", sourceLocale)
                    put("targetLanguage", targetLocale)
                }
            )

            return
        }

        val translator = getTranslator(source, target)

        val conditions = DownloadConditions.Builder().build()

        translator
            .downloadModelIfNeeded(conditions)
            .addOnSuccessListener {
                translator
                    .translate(text)
                    .addOnSuccessListener { translated ->
                        call.resolve(
                            JSObject().apply {
                                put("originalText", text)

                                put("translatedText", translated)

                                put("sourceLanguage", sourceLocale)

                                put("targetLanguage", targetLocale)
                            }
                        )
                    }
                    .addOnFailureListener { error ->
                        call.reject(error.message ?: "Translation failed.", error)
                    }
            }
            .addOnFailureListener { error ->
                call.reject(error.message ?: "Translation model download failed.", error)
            }
    }

    private fun getTranslator(source: String, target: String): Translator {

        if (translator != null && currentSource == source && currentTarget == target) {
            return translator!!
        }

        translator?.close()

        val options =
            TranslatorOptions.Builder().setSourceLanguage(source).setTargetLanguage(target).build()

        translator = Translation.getClient(options)

        currentSource = source
        currentTarget = target

        return translator!!
    }

    private fun toMlKitLanguage(locale: String): String? {

        val language = locale.substringBefore('-').lowercase()

        return when (language) {
            "en" -> TranslateLanguage.ENGLISH
            "de" -> TranslateLanguage.GERMAN
            "es" -> TranslateLanguage.SPANISH
            "fr" -> TranslateLanguage.FRENCH
            "it" -> TranslateLanguage.ITALIAN
            "pt" -> TranslateLanguage.PORTUGUESE
            "ar" -> TranslateLanguage.ARABIC
            "ru" -> TranslateLanguage.RUSSIAN
            "hr" -> TranslateLanguage.CROATIAN

            else -> null
        }
    }

    override fun handleOnDestroy() {

        translator?.close()
        translator = null

        super.handleOnDestroy()
    }
}
