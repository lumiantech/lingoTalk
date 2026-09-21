package io.ionic.starter

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.util.Log
import java.io.FileNotFoundException

class SharedAudioProvider : ContentProvider() {

    companion object {
        private const val TAG = "LingoAudioProvider"
    }

    override fun onCreate(): Boolean {

        Log.e(TAG, "★★★★★ SharedAudioProvider CREATED ★★★★★")

        return true
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {

        Log.e(TAG, "★★★★★ OPENFILE CALLED uri=$uri mode=$mode ★★★★★")

        if (uri.lastPathSegment != "live") {

            Log.e(TAG, "Unknown audio URI: $uri")

            throw FileNotFoundException("Unknown audio URI: $uri")
        }

        Log.e(TAG, "Opening live shared audio stream")

        val descriptor = SharedAudioStream.createPipe()

        Log.e(TAG, "★★★★★ PIPE DESCRIPTOR RETURNED TO CALLER ★★★★★")

        return descriptor
    }

    override fun getType(uri: Uri): String {

        Log.d(TAG, "getType uri=$uri")

        return "audio/raw"
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? {

        Log.d(TAG, "query uri=$uri")

        return null
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? {

        Log.d(TAG, "insert uri=$uri")

        return null
    }

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int {

        Log.d(TAG, "delete uri=$uri")

        return 0
    }

    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?,
    ): Int {

        Log.d(TAG, "update uri=$uri")

        return 0
    }
}
