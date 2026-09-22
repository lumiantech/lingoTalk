package io.ionic.starter

import android.content.Context
import android.util.Log
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream

object SherpaModelInstaller {

    private const val TAG = "LingoSherpaInstall"

    const val MODEL_DIR = "sherpa/nemotron-3.5-streaming-0.6b-560ms-int8"

    private const val ARCHIVE_NAME =
        "sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11.tar.bz2"

    private const val DOWNLOAD_URL =
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$ARCHIVE_NAME"

    private val REQUIRED_FILES =
        listOf("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt")

    fun isInstalled(context: Context): Boolean {

        val dir = File(context.filesDir, MODEL_DIR)

        if (!dir.isDirectory) {
            return false
        }

        return REQUIRED_FILES.all { name ->
            val file = File(dir, name)

            file.isFile && file.length() > 0L
        }
    }

    fun ensureInstalled(context: Context, onProgress: (Int) -> Unit = {}) {

        if (isInstalled(context)) {

            Log.i(TAG, "★★★★★ MODEL ALREADY INSTALLED ★★★★★")

            return
        }

        Log.i(TAG, "★★★★★ MODEL NOT INSTALLED ★★★★★")
        Log.i(TAG, "★★★★★ DOWNLOADING MODEL ★★★★★")

        val cacheArchive = File(context.cacheDir, ARCHIVE_NAME)

        download(cacheArchive, onProgress)

        Log.i(TAG, "★★★★★ DOWNLOAD COMPLETE bytes=${cacheArchive.length()} ★★★★★")

        installArchive(context, cacheArchive)

        if (!isInstalled(context)) {

            throw IllegalStateException(
                "Sherpa model installation finished but required model files are missing"
            )
        }

        try {
            cacheArchive.delete()
        } catch (_: Exception) {}

        Log.i(TAG, "★★★★★ SHERPA MODEL INSTALL COMPLETE ★★★★★")
    }

    private fun download(destination: File, onProgress: (Int) -> Unit) {

        if (destination.exists()) {
            destination.delete()
        }

        val connection = URL(DOWNLOAD_URL).openConnection() as HttpURLConnection

        connection.instanceFollowRedirects = true
        connection.connectTimeout = 30_000
        connection.readTimeout = 30_000
        connection.requestMethod = "GET"

        try {

            connection.connect()

            val responseCode = connection.responseCode

            if (responseCode < 200 || responseCode >= 300) {

                throw IllegalStateException("Model download failed. HTTP $responseCode")
            }

            val totalBytes = connection.contentLengthLong

            Log.i(TAG, "Download content length=$totalBytes")

            BufferedInputStream(connection.inputStream, 1024 * 1024).use { input ->
                BufferedOutputStream(FileOutputStream(destination), 1024 * 1024).use { output ->
                    val buffer = ByteArray(1024 * 1024)

                    var downloaded = 0L
                    var lastProgress = -1

                    while (true) {

                        val count = input.read(buffer)

                        if (count < 0) {
                            break
                        }

                        output.write(buffer, 0, count)

                        downloaded += count

                        if (totalBytes > 0) {

                            val progress = (downloaded * 100L / totalBytes).toInt()

                            if (progress != lastProgress) {

                                lastProgress = progress

                                onProgress(progress)

                                if (progress % 5 == 0) {

                                    Log.i(
                                        TAG,
                                        "★★★★★ DOWNLOAD $progress% " +
                                            "$downloaded/$totalBytes ★★★★★",
                                    )
                                }
                            }
                        }
                    }

                    output.flush()
                }
            }
        } finally {

            connection.disconnect()
        }
    }

    private fun installArchive(context: Context, archive: File) {

        val finalDir = File(context.filesDir, MODEL_DIR)

        val tempDir = File(context.filesDir, "$MODEL_DIR-installing")

        if (tempDir.exists()) {
            tempDir.deleteRecursively()
        }

        tempDir.mkdirs()

        Log.i(TAG, "★★★★★ EXTRACTING MODEL ★★★★★")

        BufferedInputStream(archive.inputStream(), 1024 * 1024).use { fileInput ->
            BZip2CompressorInputStream(fileInput).use { bzInput ->
                TarArchiveInputStream(bzInput).use { tarInput ->
                    while (true) {

                        val entry = tarInput.nextEntry ?: break

                        if (entry.isDirectory) {
                            continue
                        }

                        val name = File(entry.name).name

                        if (name !in REQUIRED_FILES) {
                            continue
                        }

                        val outputFile = File(tempDir, name)

                        Log.i(TAG, "Extracting $name")

                        BufferedOutputStream(FileOutputStream(outputFile), 1024 * 1024).use { output
                            ->
                            val buffer = ByteArray(1024 * 1024)

                            while (true) {

                                val count = tarInput.read(buffer)

                                if (count < 0) {
                                    break
                                }

                                output.write(buffer, 0, count)
                            }

                            output.flush()
                        }

                        Log.i(TAG, "Extracted $name bytes=${outputFile.length()}")
                    }
                }
            }
        }

        val missing = REQUIRED_FILES.filter {
            val file = File(tempDir, it)

            !file.isFile || file.length() == 0L
        }

        if (missing.isNotEmpty()) {

            tempDir.deleteRecursively()

            throw IllegalStateException(
                "Downloaded Sherpa archive is missing: " + missing.joinToString()
            )
        }

        if (finalDir.exists()) {
            finalDir.deleteRecursively()
        }

        finalDir.parentFile?.mkdirs()

        if (!tempDir.renameTo(finalDir)) {

            throw IllegalStateException("Could not move Sherpa model into ${finalDir.absolutePath}")
        }

        Log.i(TAG, "★★★★★ MODEL INSTALLED AT ${finalDir.absolutePath} ★★★★★")
    }
}
