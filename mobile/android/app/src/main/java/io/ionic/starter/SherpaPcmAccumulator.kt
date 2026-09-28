package io.ionic.starter

class SherpaPcmAccumulator(private val onChunk: (ByteArray) -> Unit) {

    companion object {
        // 16 kHz * 0.1 sec * 2 bytes
        private const val CHUNK_SIZE = 3_200
    }

    private val buffer = ByteArray(CHUNK_SIZE)

    private var position = 0

    @Synchronized
    fun write(data: ByteArray) {

        var sourceOffset = 0

        while (sourceOffset < data.size) {

            val remaining = CHUNK_SIZE - position

            val copyLength = minOf(remaining, data.size - sourceOffset)

            System.arraycopy(data, sourceOffset, buffer, position, copyLength)

            position += copyLength
            sourceOffset += copyLength

            if (position == CHUNK_SIZE) {

                onChunk(buffer.copyOf())

                position = 0
            }
        }
    }

    @Synchronized
    fun reset() {
        position = 0
    }
}
