class PcmAudioProcessor extends AudioWorkletProcessor {

    constructor(options) {

        super();

        const processorOptions =
            options.processorOptions || {};

        this.sourceSampleRate =
            processorOptions.sourceSampleRate ||
            sampleRate;

        this.targetSampleRate =
            processorOptions.targetSampleRate ||
            16000;

        this.chunkDurationMs =
            processorOptions.chunkDurationMs ||
            100;

        this.chunkSamples =
            Math.round(
                this.targetSampleRate *
                this.chunkDurationMs /
                1000
            );

        this.pendingSamples = [];

        this.resamplePosition = 0;

        this.resampleRatio =
            this.sourceSampleRate /
            this.targetSampleRate;


        // ============================================================
        // RAW INPUT DIAGNOSTICS
        //
        // This does NOT modify audio.
        // It only measures the original input received by the worklet
        // BEFORE resampling from 48 kHz -> 16 kHz.
        // ============================================================

        this.rawBlockCount = 0;
        this.rawSampleCount = 0;

        this.rawWindowSamples = 0;
        this.rawWindowAbsSum = 0;
        this.rawWindowPeak = 0;

        // Report approximately every 100 ms.
        this.rawReportSamples =
            Math.max(
                1,
                Math.round(
                    this.sourceSampleRate *
                    this.chunkDurationMs /
                    1000
                )
            );


        // Tell the main thread what configuration the worklet is using.
        this.port.postMessage({
            type: 'pcm-debug-config',
            sourceSampleRate: this.sourceSampleRate,
            targetSampleRate: this.targetSampleRate,
            chunkDurationMs: this.chunkDurationMs,
            chunkSamples: this.chunkSamples,
            resampleRatio: this.resampleRatio
        });
    }


    process(inputs) {

        const input =
            inputs[0];

        if (
            !input ||
            input.length === 0
        ) {

            return true;
        }

        const channel =
            input[0];

        if (!channel) {
            return true;
        }


        // ============================================================
        // IMPORTANT:
        // Measure RAW microphone/WebAudio samples BEFORE resampling.
        //
        // We do not modify channel[].
        // ============================================================

        this.measureRawInput(
            channel
        );


        // Existing audio path remains unchanged.

        this.processInput(
            channel
        );

        return true;
    }


    measureRawInput(input) {

        this.rawBlockCount++;

        for (
            let index = 0;
            index < input.length;
            index++
        ) {

            const sample =
                input[index];

            const absolute =
                Math.abs(
                    sample
                );

            this.rawWindowSamples++;

            this.rawSampleCount++;

            this.rawWindowAbsSum +=
                absolute;

            if (
                absolute >
                this.rawWindowPeak
            ) {

                this.rawWindowPeak =
                    absolute;
            }
        }


        // Send one diagnostic report for approximately every
        // chunkDurationMs of original source audio.

        if (
            this.rawWindowSamples >=
            this.rawReportSamples
        ) {

            const averageAbsolute =
                this.rawWindowSamples > 0
                    ? this.rawWindowAbsSum /
                      this.rawWindowSamples
                    : 0;

            this.port.postMessage({
                type: 'pcm-debug-raw',

                blockCount:
                    this.rawBlockCount,

                totalSamples:
                    this.rawSampleCount,

                windowSamples:
                    this.rawWindowSamples,

                peak:
                    this.rawWindowPeak,

                avgAbs:
                    averageAbsolute,

                sourceSampleRate:
                    this.sourceSampleRate
            });


            this.rawWindowSamples = 0;

            this.rawWindowAbsSum = 0;

            this.rawWindowPeak = 0;
        }
    }


    processInput(input) {

        let position =
            this.resamplePosition;

        while (
            position <
            input.length
        ) {

            const index =
                Math.floor(
                    position
                );

            const nextIndex =
                Math.min(
                    index + 1,
                    input.length - 1
                );

            const fraction =
                position - index;

            const first =
                input[index];

            const second =
                input[nextIndex];

            const sample =
                first +
                (second - first) *
                fraction;

            this.pendingSamples.push(
                sample
            );

            position +=
                this.resampleRatio;
        }

        this.resamplePosition =
            position -
            input.length;

        while (
            this.pendingSamples.length >=
            this.chunkSamples
        ) {

            const chunk =
                this.pendingSamples.splice(
                    0,
                    this.chunkSamples
                );

            this.sendPcm16(
                chunk
            );
        }
    }


    sendPcm16(samples) {

        const pcm =
            new Int16Array(
                samples.length
            );

        for (
            let index = 0;
            index < samples.length;
            index++
        ) {

            const sample =
                Math.max(
                    -1,
                    Math.min(
                        1,
                        samples[index]
                    )
                );

            pcm[index] =
                sample < 0
                    ? sample * 32768
                    : sample * 32767;
        }

        this.port.postMessage(
            pcm.buffer,
            [
                pcm.buffer
            ]
        );
    }
}


registerProcessor(
    'pcm-audio-processor',
    PcmAudioProcessor
);