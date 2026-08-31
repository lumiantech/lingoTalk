import {
    Service,
    signal
} from '@angular/core';

@Service()
export class WebRtcService {

    private peerConnection?: RTCPeerConnection;

    private localStream?: MediaStream;
    private remoteStream?: MediaStream;

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

    async initializeMedia(): Promise<MediaStream> {

        if (this.localStream) {
            return this.localStream;
        }

        this.localStream =
            await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'user'
                },

                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

        this.localMediaStream.set(
            this.localStream
        );

        return this.localStream;
    }

    async createPeerConnection(
        onIceCandidate:
            (candidate: RTCIceCandidateInit) => void,
        forceNew = false
    ): Promise<RTCPeerConnection> {

        if (forceNew && this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = undefined;
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
            const track of localStream.getTracks()
        ) {
            peerConnection.addTrack(
                track,
                localStream
            );
        }

        peerConnection.onicecandidate =
            event => {

                if (!event.candidate) {
                    return;
                }

                onIceCandidate(
                    event.candidate.toJSON()
                );
            };

        peerConnection.ontrack =
            event => {

                const stream =
                    event.streams[0];

                if (!stream) {
                    return;
                }

                this.remoteStream =
                    stream;

                this.remoteMediaStream.set(
                    stream
                );
            };

        peerConnection.onconnectionstatechange =
            () => {

                this.callState.set(
                    peerConnection.connectionState
                );

                this.callConnected.set(
                    peerConnection.connectionState ===
                    'connected'
                );
            };

        return peerConnection;
    }

    async createOffer():
        Promise<RTCSessionDescriptionInit> {
        const peer =
            this.requirePeerConnection();

        const offer = await peer.createOffer();

        await peer.setLocalDescription(offer);

        return offer;
    }

    async acceptOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {

        const peer = this.requirePeerConnection();

        await peer.setRemoteDescription(
            offer
        );

        const answer =
            await peer.createAnswer();

        await peer.setLocalDescription(
            answer
        );

        return answer;
    }

    async acceptAnswer(
        answer: RTCSessionDescriptionInit
    ): Promise<void> {

        const peer =
            this.requirePeerConnection();

        await peer.setRemoteDescription(
            answer
        );
    }

    async addIceCandidate(
        candidate: RTCIceCandidateInit
    ): Promise<void> {

        const peer =
            this.requirePeerConnection();

        await peer.addIceCandidate(
            candidate
        );
    }

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
            track.enabled = enabled;
        }
    }

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
            track.enabled = enabled;
        }
    }

    async endCall(): Promise<void> {

        this.peerConnection?.close();

        this.peerConnection = undefined;

        if (this.localStream) {
            for (
                const track of
                this.localStream.getTracks()
            ) {
                track.stop();
            }
        }

        this.localStream = undefined;
        this.remoteStream = undefined;

        this.localMediaStream.set(null);
        this.remoteMediaStream.set(null);

        this.callConnected.set(false);
        this.callState.set('closed');
    }

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