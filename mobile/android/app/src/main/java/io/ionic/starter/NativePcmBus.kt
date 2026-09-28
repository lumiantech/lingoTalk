package io.ionic.starter

object NativePcmBus {

    interface Listener {
        fun onPcm16k(pcm: ByteArray)
    }

    @Volatile private var listener: Listener? = null

    fun setListener(value: Listener?) {
        listener = value
    }

    fun publish(pcm: ByteArray) {
        if (pcm.isEmpty()) return

        listener?.onPcm16k(pcm)

        // Existing Google SpeechRecognizer injection path.
        if (SharedAudioStream.isOpen()) {
            SharedAudioStream.write(pcm)
        }
    }
}
