import {
    Injectable,
    signal
} from '@angular/core';

import {
    Capacitor,
    registerPlugin
} from '@capacitor/core';


interface SpeechRecognitionNativePlugin {

    pushAudio(options: {
        data: string;
    }): Promise<void>;
}


const SpeechRecognition =
    registerPlugin<SpeechRecognitionNativePlugin>(
        'SpeechRecognition'
    );


@Injectable({
    providedIn: 'root'
})
export class WebRtcService {

    private peerConnection?: RTCPeerConnection;

    private pendingIceCandidates:
        RTCIceCandidateInit[] = [];

    private localStream?: MediaStream;

    private remoteStream?: MediaStream;


    private audioContext?: AudioContext;

    private audioSourceNode?:
        MediaStreamAudioSourceNode;

    private audioWorkletNode?:
        AudioWorkletNode;


    readonly localMediaStream =
        signal<MediaStream | null>(null);

    readonly remoteMediaStream =
        signal<MediaStream | null>(null);

    readonly callConnected =
        signal(false);

    readonly callState =
        signal<RTCPeerConnectionState>(
            'new'
        );


    // ============================================================
    // MEDIA
    // ============================================================


    async initializeMedia(): Promise<MediaStream> {

        if (this.localStream) {

            console.log(
                '★★★★★ [MEDIA] Reusing existing localStream ★★★★★'
            );

            // Ako stream već postoji, svejedno osiguraj da PCM tap radi.
            await this.startPcmTap(
                this.localStream
            );

            return this.localStream;
        }


        console.log(
            '★★★★★ [MEDIA] Requesting camera + microphone ★★★★★'
        );


        this.localStream =
            await navigator.mediaDevices.getUserMedia({

                video: {
                    facingMode: 'user'
                },

                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });


        console.log(
            '★★★★★ [MEDIA] getUserMedia SUCCESS ★★★★★'
        );

        console.log(
    '★★★★★ [MEDIA] video tracks:',
    this.localStream.getVideoTracks().length,
    '★★★★★'
);

for (const track of this.localStream.getVideoTracks()) {

    console.log(
        '★★★★★ [MEDIA] VIDEO TRACK:',
        track.label,
        'enabled=',
        track.enabled,
        'readyState=',
        track.readyState,
        'settings=',
        track.getSettings(),
        '★★★★★'
    );
}


        console.log(
            '★★★★★ [MEDIA] audio tracks:',
            this.localStream.getAudioTracks().length,
            '★★★★★'
        );


        this.localMediaStream.set(
            this.localStream
        );


        /*
         * VAŽNO:
         *
         * PCM tap pokrećemo ODMAH nakon što smo dobili mikrofon.
         *
         * Više ne čekamo:
         *
         * RTCPeerConnection.connectionState === 'connected'
         *
         * Isti MediaStream sada ide:
         *
         * 1. u WebRTC
         * 2. u AudioWorklet -> PCM -> native SpeechRecognition plugin
         */

        try {

            await this.startPcmTap(
                this.localStream
            );


            console.log(
                '★★★★★ [MEDIA] PCM tap initialized from localStream ★★★★★'
            );

        } catch (error) {

            console.error(
                '★★★★★ [MEDIA] PCM tap initialization FAILED ★★★★★',
                error
            );
        }


        return this.localStream;
    }




    // ============================================================
    // PEER CONNECTION
    // ============================================================

    async createPeerConnection(
        onIceCandidate:
            (candidate: RTCIceCandidateInit) => void,

        forceNew = false

    ): Promise<RTCPeerConnection> {


        if (
            forceNew &&
            this.peerConnection
        ) {

            this.peerConnection.close();

            this.peerConnection =
                undefined;

            this.pendingIceCandidates =
                [];
        }


        if (this.peerConnection) {

            return this.peerConnection;
        }


        const peerConnection =
            new RTCPeerConnection({

                iceServers: [
                    {
                        urls:
                            'stun:stun.l.google.com:19302'
                    }
                ]
            });


        this.peerConnection =
            peerConnection;


        const localStream =
            await this.initializeMedia();


        for (
            const track of
            localStream.getTracks()
        ) {

            peerConnection.addTrack(
                track,
                localStream
            );
        }


        // --------------------------------------------------------
        // ICE
        // --------------------------------------------------------

        peerConnection.onicecandidate =
    event => {

        if (!event.candidate) {

            console.log(
                '★★★★★ [WEBRTC] ICE GATHERING COMPLETE ★★★★★'
            );

            return;
        }

        console.log(
            '★★★★★ [WEBRTC] LOCAL ICE CANDIDATE:',
            event.candidate.type,
            event.candidate.protocol,
            event.candidate.address,
            event.candidate.port,
            '★★★★★'
        );

        onIceCandidate(
            event.candidate.toJSON()
        );
    };

        peerConnection.onicegatheringstatechange =
    () => {

        console.log(
            '★★★★★ [WEBRTC] ICE GATHERING STATE:',
            peerConnection.iceGatheringState,
            '★★★★★'
        );
    };


peerConnection.oniceconnectionstatechange =
    () => {

        console.log(
            '★★★★★ [WEBRTC] ICE CONNECTION STATE:',
            peerConnection.iceConnectionState,
            '★★★★★'
        );
    };


peerConnection.onsignalingstatechange =
    () => {

        console.log(
            '★★★★★ [WEBRTC] SIGNALING STATE:',
            peerConnection.signalingState,
            '★★★★★'
        );
    };


        // --------------------------------------------------------
        // REMOTE TRACK
        // --------------------------------------------------------

        peerConnection.ontrack =
            event => {

                const stream =
                    event.streams[0];

                console.log(
    '★★★★★ [WEBRTC] REMOTE TRACK:',
    event.track.kind,
    'enabled=',
    event.track.enabled,
    'readyState=',
    event.track.readyState,
    'streams=',
    event.streams.length,
    '★★★★★'
);


                if (!stream) {

                    return;
                }


                this.remoteStream =
                    stream;


                this.remoteMediaStream.set(
                    stream
                );
            };


        // --------------------------------------------------------
        // CONNECTION STATE
        // --------------------------------------------------------

      
peerConnection.onconnectionstatechange =
    () => {

        const state =
            peerConnection.connectionState;


        console.log(
            '★★★★★ [WEBRTC] CONNECTION STATE:',
            state,
            '★★★★★'
        );


        this.callState.set(
            state
        );


        const connected =
            state === 'connected';


        this.callConnected.set(
            connected
        );
    };




        return peerConnection;
    }


    // ============================================================
    // OFFER
    // ============================================================

    async createOffer():
        Promise<RTCSessionDescriptionInit> {

        const peer =
            this.requirePeerConnection();


        const offer =
            await peer.createOffer();


        await peer.setLocalDescription(
            offer
        );


        return offer;
    }


    // ============================================================
    // ACCEPT OFFER
    // ============================================================

    async acceptOffer(
        offer: RTCSessionDescriptionInit
    ): Promise<RTCSessionDescriptionInit> {

        const peer =
            this.requirePeerConnection();


        await peer.setRemoteDescription(
            offer
        );


        await this.flushPendingIceCandidates();


        const answer =
            await peer.createAnswer();


        await peer.setLocalDescription(
            answer
        );


        return answer;
    }


    // ============================================================
    // ACCEPT ANSWER
    // ============================================================

    async acceptAnswer(
        answer: RTCSessionDescriptionInit
    ): Promise<void> {

        const peer =
            this.requirePeerConnection();


        await peer.setRemoteDescription(
            answer
        );


        await this.flushPendingIceCandidates();
    }


    // ============================================================
    // ICE CANDIDATE
    // ============================================================

    async addIceCandidate(
    candidate: RTCIceCandidateInit
): Promise<void> {

    const peer =
        this.requirePeerConnection();


    console.log(
        '★★★★★ [WEBRTC] REMOTE ICE CANDIDATE RECEIVED:',
        candidate.candidate,
        'sdpMid=',
        candidate.sdpMid,
        'sdpMLineIndex=',
        candidate.sdpMLineIndex,
        '★★★★★'
    );


    if (!peer.remoteDescription) {

        console.log(
            '★★★★★ [WEBRTC] QUEUING REMOTE ICE CANDIDATE - no remoteDescription yet ★★★★★'
        );

        this.pendingIceCandidates.push(
            candidate
        );

        return;
    }


    console.log(
        '★★★★★ [WEBRTC] ADDING REMOTE ICE CANDIDATE ★★★★★'
    );


    await peer.addIceCandidate(
        candidate
    );
}


    // ============================================================
    // FLUSH ICE
    // ============================================================

    private async flushPendingIceCandidates():
        Promise<void> {

        const peer =
            this.requirePeerConnection();


        if (!peer.remoteDescription) {

            return;
        }


        const candidates =
            this.pendingIceCandidates.splice(
                0
            );


        for (
            const candidate of
            candidates
        ) {

            await peer.addIceCandidate(
                candidate
            );
        }
    }


    // ============================================================
    // PCM TAP
    // ============================================================

    private async startPcmTap(
        stream: MediaStream
    ): Promise<void> {


        console.log(
            '★★★★★ [PCM] startPcmTap CALLED ★★★★★'
        );


        if (this.audioContext) {

            console.log(
                '★★★★★ [PCM] AudioContext already exists ★★★★★'
            );

            return;
        }


        const audioTracks =
            stream.getAudioTracks();


        console.log(
            '★★★★★ [PCM] microphone tracks:',
            audioTracks.length
        );


        if (audioTracks.length === 0) {

            console.warn(
                '★★★★★ [PCM] No microphone audio track ★★★★★'
            );

            return;
        }


        console.log(
            '★★★★★ [PCM] microphone track enabled:',
            audioTracks[0].enabled,
            'readyState:',
            audioTracks[0].readyState
        );


        const audioContext =
            new AudioContext();


        this.audioContext =
            audioContext;


        console.log(
            '★★★★★ [PCM] AudioContext sampleRate:',
            audioContext.sampleRate,
            'state:',
            audioContext.state
        );


        try {

            console.log(
                '★★★★★ [PCM] Loading /pcm-audio-processor.js ★★★★★'
            );


            await audioContext.audioWorklet.addModule(
                '/pcm-audio-processor.js'
            );


            console.log(
                '★★★★★ [PCM] AudioWorklet module LOADED ★★★★★'
            );

        } catch (error) {

            console.error(
                '★★★★★ [PCM] AudioWorklet module FAILED ★★★★★',
                error
            );

            throw error;
        }


        const source =
            audioContext.createMediaStreamSource(
                stream
            );


        this.audioSourceNode =
            source;


        console.log(
            '★★★★★ [PCM] MediaStreamAudioSourceNode created ★★★★★'
        );


        const worklet =
            new AudioWorkletNode(
                audioContext,
                'pcm-audio-processor',
                {
                    processorOptions: {

                        sourceSampleRate:
                            audioContext.sampleRate,

                        targetSampleRate:
                            16000,

                        chunkDurationMs:
                            100
                    }
                }
            );


        this.audioWorkletNode =
            worklet;


        console.log(
            '★★★★★ [PCM] AudioWorkletNode created ★★★★★'
        );


        let workletMessageCount = 0;


        worklet.port.onmessage =
            event => {

                const data =
                    event.data;


                // RAW 48 kHz diagnostic message.
                // Never forward diagnostic objects to native STT.
                if (
                    data &&
                    typeof data === 'object' &&
                    !(data instanceof ArrayBuffer) &&
                    data.type === 'pcm-debug-raw'
                ) {

                    console.log(
                        '★★★★★ [PCM RAW 48K]',
                        'blocks=', data.blockCount,
                        'samples=', data.windowSamples,
                        'totalSamples=', data.totalSamples,
                        'peak=', data.peak,
                        'avgAbs=', data.avgAbs,
                        'sampleRate=', data.sourceSampleRate,
                        '★★★★★'
                    );

                    return;
                }


                // Worklet configuration diagnostic message.
                if (
                    data &&
                    typeof data === 'object' &&
                    !(data instanceof ArrayBuffer) &&
                    data.type === 'pcm-debug-config'
                ) {

                    console.log(
                        '★★★★★ [PCM WORKLET CONFIG]',
                        data,
                        '★★★★★'
                    );

                    return;
                }


                // Only ArrayBuffer messages are actual 16 kHz PCM16.
                if (!(data instanceof ArrayBuffer)) {

                    console.warn(
                        '★★★★★ [PCM] UNKNOWN WORKLET MESSAGE - IGNORED ★★★★★',
                        data
                    );

                    return;
                }


                const pcm =
                    data;


                workletMessageCount++;


                if (
                    workletMessageCount <= 5 ||
                    workletMessageCount % 50 === 0
                ) {

                    console.log(
                        '★★★★★ [PCM] WORKLET MESSAGE',
                        'count=',
                        workletMessageCount,
                        'bytes=',
                        pcm.byteLength,
                        '★★★★★'
                    );
                }


                void this.sendPcmToNative(
                    pcm
                );
            };


        source.connect(
            worklet
        );


        /*
         * AudioWorkletNode mora biti dio audio grafa
         * da bi kontinuirano obrađivao mikrofon.
         *
         * Processor ne šalje stvarni audio na output,
         * pa ne bismo trebali čuti vlastiti mikrofon.
         */

        worklet.connect(
            audioContext.destination
        );


        console.log(
            '★★★★★ [PCM] Audio graph CONNECTED ★★★★★'
        );


        if (
            audioContext.state ===
            'suspended'
        ) {

            console.log(
                '★★★★★ [PCM] AudioContext suspended -> resume() ★★★★★'
            );


            await audioContext.resume();


            console.log(
                '★★★★★ [PCM] AudioContext after resume:',
                audioContext.state,
                '★★★★★'
            );
        }


        console.log(
            '★★★★★ [PCM] Shared microphone PCM tap STARTED ★★★★★'
        );
    }


    // ============================================================
    // SEND PCM TO NATIVE
    // ============================================================

    private async sendPcmToNative(
        buffer: ArrayBuffer
    ): Promise<void> {


        if (
            Capacitor.getPlatform() !==
            'android'
        ) {

            return;
        }


        const bytes =
            new Uint8Array(
                buffer
            );


        const base64 =
            this.bytesToBase64(
                bytes
            );


        try {

            console.log(
                '★★★★★ [PCM] PUSH NATIVE bytes=',
                bytes.length,
                '★★★★★'
            );


            await SpeechRecognition.pushAudio({
                data: base64
            });


        } catch (error) {

            console.error(
                '★★★★★ [PCM] pushAudio FAILED ★★★★★',
                error
            );
        }
    }


    // ============================================================
    // BASE64
    // ============================================================

    private bytesToBase64(
        bytes: Uint8Array
    ): string {

        let binary = '';


        const length =
            bytes.length;


        for (
            let index = 0;
            index < length;
            index++
        ) {

            binary +=
                String.fromCharCode(
                    bytes[index]
                );
        }


        return btoa(
            binary
        );
    }


    // ============================================================
    // STOP PCM TAP
    // ============================================================

    private async stopPcmTap():
        Promise<void> {


        if (this.audioWorkletNode) {

            this.audioWorkletNode.port.onmessage =
                null;


            try {

                this.audioWorkletNode.disconnect();

            } catch {
            }


            this.audioWorkletNode =
                undefined;
        }


        if (this.audioSourceNode) {

            try {

                this.audioSourceNode.disconnect();

            } catch {
            }


            this.audioSourceNode =
                undefined;
        }


        if (this.audioContext) {

            try {

                await this.audioContext.close();

            } catch {
            }


            this.audioContext =
                undefined;
        }


        console.log(
            '[PCM] Shared microphone PCM tap stopped'
        );
    }


    // ============================================================
    // MICROPHONE
    // ============================================================

    setMicrophoneEnabled(
        enabled: boolean
    ): void {


        if (!this.localStream) {

            return;
        }


        for (
            const track of
            this.localStream.getAudioTracks()
        ) {

            track.enabled =
                enabled;
        }
    }


    // ============================================================
    // CAMERA
    // ============================================================

    setCameraEnabled(
        enabled: boolean
    ): void {


        if (!this.localStream) {

            return;
        }


        for (
            const track of
            this.localStream.getVideoTracks()
        ) {

            track.enabled =
                enabled;
        }
    }


    // ============================================================
    // END CALL
    // ============================================================

    async endCall():
        Promise<void> {


        await this.stopPcmTap();


        this.peerConnection?.close();


        this.peerConnection =
            undefined;


        if (this.localStream) {

            for (
                const track of
                this.localStream.getTracks()
            ) {

                track.stop();
            }
        }


        this.localStream =
            undefined;


        this.remoteStream =
            undefined;


        this.localMediaStream.set(
            null
        );


        this.remoteMediaStream.set(
            null
        );


        this.callConnected.set(
            false
        );


        this.callState.set(
            'closed'
        );


        this.pendingIceCandidates =
            [];
    }


    // ============================================================
    // REQUIRE PEER
    // ============================================================

    private requirePeerConnection():
        RTCPeerConnection {


        if (!this.peerConnection) {

            throw new Error(
                'WebRTC peer connection has not been initialized.'
            );
        }


        return this.peerConnection;
    }
}