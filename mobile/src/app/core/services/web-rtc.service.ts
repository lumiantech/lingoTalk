import {
    Injectable,
    signal
} from '@angular/core';



@Injectable({
    providedIn: 'root'
})
export class WebRtcService {

    private peerConnection?: RTCPeerConnection;

    private pendingIceCandidates:
        RTCIceCandidateInit[] = [];

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


    // ============================================================
    // MEDIA
    // ============================================================


    async initializeMedia(): Promise<MediaStream> {

        if (this.localStream) {

            console.log(
                '★★★★★ [MEDIA] Reusing existing localStream ★★★★★'
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
                    // This track is CALL AUDIO only.
                    // Sherpa now records separately through native AudioRecord.
                    echoCancellation: true,
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