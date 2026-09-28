package io.ionic.starter

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

class Pcm48To16Resampler {

    companion object {
        private const val INPUT_RATE = 48_000
        private const val OUTPUT_RATE = 16_000
        private const val DECIMATION = INPUT_RATE / OUTPUT_RATE

        private const val TAP_COUNT = 63

        // Keep transition band below 8 kHz Nyquist of the 16 kHz output.
        private const val CUTOFF_HZ = 7_200.0
    }

    private val coefficients = DoubleArray(TAP_COUNT)

    private val history = DoubleArray(TAP_COUNT)

    private var historyIndex = 0
    private var decimationPhase = 0

    init {
        createFilter()
    }

    @Synchronized
    fun process(input: ByteArray): ByteArray {

        if (input.size < 2) {
            return ByteArray(0)
        }

        val sampleCount = input.size / 2

        val output = ShortArray(sampleCount / DECIMATION + 2)

        var outputCount = 0
        var byteIndex = 0

        while (byteIndex + 1 < input.size) {

            val sample =
                ((input[byteIndex].toInt() and 0xff) or (input[byteIndex + 1].toInt() shl 8))
                    .toShort()

            history[historyIndex] = sample.toDouble()

            historyIndex = (historyIndex + 1) % TAP_COUNT

            if (decimationPhase == 0) {

                var filtered = 0.0
                var historyPosition = historyIndex

                for (tap in 0 until TAP_COUNT) {

                    historyPosition--

                    if (historyPosition < 0) {
                        historyPosition = TAP_COUNT - 1
                    }

                    filtered += history[historyPosition] * coefficients[tap]
                }

                val value =
                    filtered.toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())

                output[outputCount++] = value.toShort()
            }

            decimationPhase++

            if (decimationPhase == DECIMATION) {
                decimationPhase = 0
            }

            byteIndex += 2
        }

        val bytes = ByteArray(outputCount * 2)

        var outputByte = 0

        for (i in 0 until outputCount) {

            val value = output[i].toInt()

            bytes[outputByte++] = (value and 0xff).toByte()

            bytes[outputByte++] = ((value shr 8) and 0xff).toByte()
        }

        return bytes
    }

    @Synchronized
    fun reset() {
        history.fill(0.0)
        historyIndex = 0
        decimationPhase = 0
    }

    private fun createFilter() {

        val center = (TAP_COUNT - 1) / 2.0

        val normalizedCutoff = CUTOFF_HZ / INPUT_RATE

        var sum = 0.0

        for (i in 0 until TAP_COUNT) {

            val x = i - center

            val sinc =
                if (x == 0.0) {

                    2.0 * normalizedCutoff
                } else {

                    sin(2.0 * PI * normalizedCutoff * x) / (PI * x)
                }

            // Hamming window.
            val window = 0.54 - 0.46 * cos(2.0 * PI * i / (TAP_COUNT - 1))

            coefficients[i] = sinc * window

            sum += coefficients[i]
        }

        // Unity DC gain.
        for (i in coefficients.indices) {
            coefficients[i] /= sum
        }
    }
}
