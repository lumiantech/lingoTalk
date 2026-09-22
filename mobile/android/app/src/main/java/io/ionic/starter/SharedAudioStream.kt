package io.ionic.starter

import android.os.ParcelFileDescriptor
import android.util.Log
import java.io.FileOutputStream

object SharedAudioStream {

    private const val TAG = "LingoSharedAudio"

    private var readDescriptor: ParcelFileDescriptor? = null

    private var writeDescriptor: ParcelFileDescriptor? = null

    private var outputStream: FileOutputStream? = null

    private var totalBytesWritten: Long = 0

    private var writeCount: Long = 0

    // ============================================================
    // CREATE PIPE
    // ============================================================

    @Synchronized
    fun createPipe(): ParcelFileDescriptor {

        Log.d(TAG, "★★★★★ CREATE PIPE REQUESTED ★★★★★")

        close()

        val pipe = ParcelFileDescriptor.createPipe()

        readDescriptor = pipe[0]

        writeDescriptor = pipe[1]

        outputStream = FileOutputStream(writeDescriptor!!.fileDescriptor)

        totalBytesWritten = 0

        writeCount = 0

        Log.d(TAG, "★★★★★ PIPE CREATED ★★★★★")

        Log.d(
            TAG,
            "readDescriptor=${readDescriptor != null}, " +
                "writeDescriptor=${writeDescriptor != null}, " +
                "outputStream=${outputStream != null}",
        )

        return readDescriptor!!
    }

    // ============================================================
    // IS PIPE OPEN
    // ============================================================

    @Synchronized
    fun isOpen(): Boolean {

        val open = outputStream != null && writeDescriptor != null && readDescriptor != null

        Log.d(TAG, "isOpen=$open")

        return open
    }

    // ============================================================
    // WRITE PCM
    // ============================================================

    @Synchronized
    fun write(data: ByteArray) {

        val stream = outputStream

        if (stream == null) {

            Log.e(TAG, "★★★★★ PCM DROPPED: pipe not open, " + "bytes=${data.size} ★★★★★")

            return
        }

        try {

            stream.write(data)

            writeCount++

            totalBytesWritten += data.size

            /*
             * 3200 bytes every ~100 ms means this message appears
             * approximately every 5 seconds.
             *
             * We deliberately do not log every successful write.
             */
            if (writeCount == 1L || writeCount % 50L == 0L) {

                Log.d(
                    TAG,
                    "★★★★★ PCM FLOWING: " +
                        "writes=$writeCount, " +
                        "lastBytes=${data.size}, " +
                        "totalBytes=$totalBytesWritten ★★★★★",
                )
            }
        } catch (exception: Exception) {

            Log.e(TAG, "★★★★★ PCM WRITE FAILED: " + "${exception.message} ★★★★★", exception)
        }
    }

    // ============================================================
    // CLOSE PIPE
    // ============================================================

    @Synchronized
    fun close() {

        val hadPipe = outputStream != null || writeDescriptor != null || readDescriptor != null

        if (hadPipe) {

            Log.d(
                TAG,
                "★★★★★ CLOSING PIPE: " + "writes=$writeCount, " + "bytes=$totalBytesWritten ★★★★★",
            )
        }

        try {

            outputStream?.close()
        } catch (exception: Exception) {

            Log.d(TAG, "outputStream close failed: " + "${exception.message}")
        }

        /*
         * Closing FileOutputStream normally also closes the
         * underlying write file descriptor, but we still close the
         * ParcelFileDescriptor defensively.
         */
        try {

            writeDescriptor?.close()
        } catch (exception: Exception) {

            Log.d(TAG, "writeDescriptor close failed: " + "${exception.message}")
        }

        try {

            readDescriptor?.close()
        } catch (exception: Exception) {

            Log.d(TAG, "readDescriptor close failed: " + "${exception.message}")
        }

        outputStream = null

        writeDescriptor = null

        readDescriptor = null

        totalBytesWritten = 0

        writeCount = 0

        if (hadPipe) {

            Log.d(TAG, "★★★★★ PIPE CLOSED ★★★★★")
        }
    }
}
