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

        this.processInput(
            channel
        );

        return true;
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