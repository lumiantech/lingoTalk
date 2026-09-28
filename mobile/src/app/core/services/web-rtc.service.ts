import {
    Injectable,
    signal
} from '@angular/core';

import {
    Capacitor,
    PluginListenerHandle,
    registerPlugin
} from '@capacitor/core';


// ============================================================
// NATIVE WEBRTC TYPES
// ============================================================

interface NativeSessionDescription {
    type: 'offer' | 'answer';
    sdp: string;
}

interface NativeIceCandidate {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex: number;
}

interface NativeConnectionStateEvent {
    state: string;
}

interface NativeRemoteVideoTrackEvent {
    available: boolean;
}

interface NativeWebRtcPlugin {

    initialize(): Promise<{
        initialized: boolean;
    }>;

    setVideoLayout(options: {
        pixelRatio: number;

        remote: {
            x: number;
            y: number;
            width: number;
            height: number;
            visible: boolean;
        };

        local: {
            x: number;
            y: number;
            width: number;
            height: number;
            visible: boolean;
        };
    }): Promise<void>;

    hideVideoRenderers(): Promise<void>;

    createPeerConnection(): Promise<{
        created: boolean;
    }>;

    createOffer():
        Promise<NativeSessionDescription>;

    acceptOffer(options: {
        sdp: string;
    }): Promise<NativeSessionDescription>;

    acceptAnswer(options: {
        sdp: string;
    }): Promise<void>;

    addIceCandidate(options: {
        candidate: string;
        sdpMid?: string | null;
        sdpMLineIndex: number;
    }): Promise<void>;

    setMicrophoneEnabled(options: {
        enabled: boolean;
    }): Promise<void>;

    setCameraEnabled(options: {
        enabled: boolean;
    }): Promise<void>;

    switchCamera():
        Promise<void>;

    closePeerConnection():
        Promise<void>;

    release():
        Promise<void>;

    addListener(
        eventName: 'iceCandidate',
        listenerFunc:
            (event: NativeIceCandidate) => void
    ): Promise<PluginListenerHandle>;

    addListener(
        eventName: 'connectionStateChanged',
        listenerFunc:
            (event: NativeConnectionStateEvent) => void
    ): Promise<PluginListenerHandle>;

    addListener(
        eventName: 'iceConnectionStateChanged',
        listenerFunc:
            (event: NativeConnectionStateEvent) => void
    ): Promise<PluginListenerHandle>;

    addListener(
        eventName: 'remoteVideoTrackAvailable',
        listenerFunc:
            (event: NativeRemoteVideoTrackEvent) => void
    ): Promise<PluginListenerHandle>;

    addListener(
        eventName: 'error',
        listenerFunc:
            (event: { message: string }) => void
    ): Promise<PluginListenerHandle>;
}


const NativeWebRtc =
    registerPlugin<NativeWebRtcPlugin>(
        'NativeWebRtc'
    );


// ============================================================
// SERVICE
// ============================================================

@Injectable({
    providedIn: 'root'
})
export class WebRtcService {

    /*
     * ========================================================
     * PLATFORM
     * ========================================================
     *
     * Android:
     *
     * Kotlin WebRTC
     *   camera + microphone
     *   one PeerConnection
     *
     *
     * Browser:
     *
     * Browser RTCPeerConnection
     *   camera + microphone
     *
     *
     * IMPORTANT:
     *
     * Android NEVER calls navigator.mediaDevices.getUserMedia().
     */

    private readonly nativeAndroid =
        Capacitor.getPlatform() === 'android';


    // ============================================================
    // BROWSER WEBRTC
    // ============================================================

    private peerConnection?:
        RTCPeerConnection;

    private localStream?:
        MediaStream;

    private remoteStream?:
        MediaStream;


    // ============================================================
    // ICE
    // ============================================================

    private pendingIceCandidates:
        RTCIceCandidateInit[] = [];


    /*
     * Native WebRTC does not expose remoteDescription
     * directly to TypeScript.
     *
     * We therefore track whether native remote SDP
     * has been installed.
     */

    private nativeRemoteDescriptionSet =
        false;


    // ============================================================
    // NATIVE STATE
    // ============================================================

    private nativeInitialized =
        false;

    private nativePeerCreated =
        false;

    private nativeListenersInstalled =
        false;

    private nativeListenerHandles:
        PluginListenerHandle[] = [];


    /*
     * ICE callback supplied by conversation.page.
     *
     * Both native Android and browser WebRTC feed into
     * exactly the same SignalR signaling callback.
     */

    private iceCandidateHandler?:
        (candidate: RTCIceCandidateInit) => void;


    // ============================================================
    // PUBLIC SIGNALS
    // ============================================================

    readonly localMediaStream =
        signal<MediaStream | null>(
            null
        );

    readonly remoteMediaStream =
        signal<MediaStream | null>(
            null
        );

    readonly callConnected =
        signal(false);

    readonly callState =
        signal<RTCPeerConnectionState>(
            'new'
        );


    /*
     * These are useful for the native renderer step.
     *
     * Browser continues using MediaStream.
     *
     * Android will render the actual tracks using
     * SurfaceViewRenderer.
     */

    readonly nativeLocalVideoAvailable =
        signal(false);

    readonly nativeRemoteVideoAvailable =
        signal(false);


    // ============================================================
    // PLATFORM INFORMATION
    // ============================================================

    isNativeAndroid():
        boolean {

        return this.nativeAndroid;
    }


    // ============================================================
    // MEDIA INITIALIZATION
    // ============================================================

    async initializeMedia():
        Promise<MediaStream | null> {

        /*
         * =====================================================
         * ANDROID
         * =====================================================
         *
         * DO NOT call getUserMedia().
         *
         * NativeWebRtc.initialize() creates:
         *
         * Camera2 capturer
         * VideoSource
         * VideoTrack
         *
         * JavaAudioDeviceModule
         * AudioSource
         * AudioTrack
         *
         * The ADM also feeds PCM to NativePcmBus/Sherpa.
         */

        if (this.nativeAndroid) {

            await this.ensureNativeInitialized();

            this.nativeLocalVideoAvailable.set(
                true
            );

            /*
             * There is deliberately no browser MediaStream.
             */

            this.localMediaStream.set(
                null
            );

            return null;
        }


        /*
         * =====================================================
         * BROWSER / CHROME
         * =====================================================
         */

        if (this.localStream) {

            console.log(
                '★★★★★ [MEDIA] Reusing browser localStream ★★★★★'
            );

            return this.localStream;
        }


        console.log(
            '★★★★★ [MEDIA] Browser requesting camera + microphone ★★★★★'
        );


        this.localStream =
            await navigator
                .mediaDevices
                .getUserMedia({

                    video: {
                        facingMode: 'user'
                    },

                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    }
                });


        console.log(
            '★★★★★ [MEDIA] Browser getUserMedia SUCCESS ★★★★★'
        );


        console.log(
            '★★★★★ [MEDIA] video tracks:',
            this.localStream
                .getVideoTracks()
                .length,
            '★★★★★'
        );


        console.log(
            '★★★★★ [MEDIA] audio tracks:',
            this.localStream
                .getAudioTracks()
                .length,
            '★★★★★'
        );


        this.localMediaStream.set(
            this.localStream
        );


        return this.localStream;
    }


    // ============================================================
    // CREATE PEER CONNECTION
    // ============================================================

    async createPeerConnection(
        onIceCandidate:
            (
                candidate:
                    RTCIceCandidateInit
            ) => void,

        forceNew = false

    ): Promise<RTCPeerConnection | null> {

        this.iceCandidateHandler =
            onIceCandidate;


        /*
         * =====================================================
         * ANDROID NATIVE
         * =====================================================
         */

        if (this.nativeAndroid) {

            await this.ensureNativeInitialized();


            if (
                forceNew &&
                this.nativePeerCreated
            ) {

                console.log(
                    '★★★★★ [WEBRTC NATIVE] Closing old PeerConnection ★★★★★'
                );


                await NativeWebRtc
                    .closePeerConnection();


                this.nativePeerCreated =
                    false;

                this.nativeRemoteDescriptionSet =
                    false;

                this.pendingIceCandidates =
                    [];

                this.nativeRemoteVideoAvailable.set(
                    false
                );

                this.callConnected.set(
                    false
                );

                this.callState.set(
                    'new'
                );
            }


            if (
                !this.nativePeerCreated
            ) {

                console.log(
                    '★★★★★ [WEBRTC NATIVE] Creating ONE audio+video PeerConnection ★★★★★'
                );


                await NativeWebRtc
                    .createPeerConnection();


                this.nativePeerCreated =
                    true;

                this.nativeRemoteDescriptionSet =
                    false;


                console.log(
                    '★★★★★ [WEBRTC NATIVE] PeerConnection CREATED ★★★★★'
                );
            }


            /*
             * No browser RTCPeerConnection exists on Android.
             */

            return null;
        }


        /*
         * =====================================================
         * BROWSER
         * =====================================================
         */

        if (
            forceNew &&
            this.peerConnection
        ) {

            this.peerConnection.close();

            this.peerConnection =
                undefined;

            this.pendingIceCandidates =
                [];

            this.remoteStream =
                undefined;

            this.remoteMediaStream.set(
                null
            );
        }


        if (
            this.peerConnection
        ) {

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


        if (!localStream) {

            throw new Error(
                'Browser local MediaStream was not created.'
            );
        }


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
        // BROWSER ICE
        // --------------------------------------------------------

        peerConnection.onicecandidate =
            event => {

                if (!event.candidate) {

                    console.log(
                        '★★★★★ [WEBRTC BROWSER] ICE GATHERING COMPLETE ★★★★★'
                    );

                    return;
                }


                console.log(
                    '★★★★★ [WEBRTC BROWSER] LOCAL ICE CANDIDATE ★★★★★'
                );


                this.iceCandidateHandler?.(
                    event.candidate.toJSON()
                );
            };


        peerConnection
            .onicegatheringstatechange =
            () => {

                console.log(
                    '★★★★★ [WEBRTC BROWSER] ICE GATHERING STATE:',
                    peerConnection
                        .iceGatheringState,
                    '★★★★★'
                );
            };


        peerConnection
            .oniceconnectionstatechange =
            () => {

                console.log(
                    '★★★★★ [WEBRTC BROWSER] ICE CONNECTION STATE:',
                    peerConnection
                        .iceConnectionState,
                    '★★★★★'
                );
            };


        peerConnection
            .onsignalingstatechange =
            () => {

                console.log(
                    '★★★★★ [WEBRTC BROWSER] SIGNALING STATE:',
                    peerConnection
                        .signalingState,
                    '★★★★★'
                );
            };


        // --------------------------------------------------------
        // BROWSER REMOTE TRACK
        // --------------------------------------------------------

        peerConnection.ontrack =
            event => {

                console.log(
                    '★★★★★ [WEBRTC BROWSER] REMOTE TRACK:',
                    event.track.kind,
                    'enabled=',
                    event.track.enabled,
                    'readyState=',
                    event.track.readyState,
                    '★★★★★'
                );


                /*
                 * Usually event.streams[0] exists because
                 * Android adds tracks using STREAM_ID.
                 *
                 * Still handle Unified Plan tracks without
                 * an attached stream.
                 */

                let stream =
                    event.streams[0];


                if (!stream) {

                    if (!this.remoteStream) {

                        this.remoteStream =
                            new MediaStream();
                    }


                    this.remoteStream.addTrack(
                        event.track
                    );


                    stream =
                        this.remoteStream;

                } else {

                    this.remoteStream =
                        stream;
                }


                this.remoteMediaStream.set(
                    stream
                );
            };


        // --------------------------------------------------------
        // BROWSER CONNECTION STATE
        // --------------------------------------------------------

        peerConnection
            .onconnectionstatechange =
            () => {

                const state =
                    peerConnection
                        .connectionState;


                console.log(
                    '★★★★★ [WEBRTC BROWSER] CONNECTION STATE:',
                    state,
                    '★★★★★'
                );


                this.callState.set(
                    state
                );


                this.callConnected.set(
                    state === 'connected'
                );
            };


        return peerConnection;
    }


    // ============================================================
    // CREATE OFFER
    // ============================================================

    async createOffer():
        Promise<RTCSessionDescriptionInit> {

        /*
         * Android native.
         */

        if (this.nativeAndroid) {

            this.requireNativePeer();


            const offer =
                await NativeWebRtc
                    .createOffer();


            console.log(
                '★★★★★ [WEBRTC NATIVE] OFFER CREATED ★★★★★'
            );


            return {
                type: 'offer',
                sdp: offer.sdp
            };
        }


        /*
         * Browser.
         */

        const peer =
            this.requireBrowserPeerConnection();


        const offer =
            await peer.createOffer();


        await peer.setLocalDescription(
            offer
        );


        return {
            type: offer.type,
            sdp: offer.sdp
        };
    }


    // ============================================================
    // ACCEPT OFFER
    // ============================================================

    async acceptOffer(
        offer:
            RTCSessionDescriptionInit
    ): Promise<RTCSessionDescriptionInit> {

        if (!offer.sdp) {

            throw new Error(
                'WebRTC offer has no SDP.'
            );
        }


        /*
         * =====================================================
         * ANDROID NATIVE
         * =====================================================
         */

        if (this.nativeAndroid) {

            this.requireNativePeer();


            const answer =
                await NativeWebRtc
                    .acceptOffer({
                        sdp:
                            offer.sdp
                    });


            /*
             * NativeWebRtc.acceptOffer():
             *
             * setRemoteDescription(offer)
             * createAnswer()
             * setLocalDescription(answer)
             *
             * Therefore remote SDP is now installed.
             */

            this.nativeRemoteDescriptionSet =
                true;


            await this
                .flushPendingIceCandidates();


            console.log(
                '★★★★★ [WEBRTC NATIVE] REMOTE OFFER ACCEPTED / ANSWER CREATED ★★★★★'
            );


            return {
                type: 'answer',
                sdp: answer.sdp
            };
        }


        /*
         * =====================================================
         * BROWSER
         * =====================================================
         */

        const peer =
            this.requireBrowserPeerConnection();


        await peer.setRemoteDescription(
            offer
        );


        await this
            .flushPendingIceCandidates();


        const answer =
            await peer.createAnswer();


        await peer.setLocalDescription(
            answer
        );


        return {
            type: answer.type,
            sdp: answer.sdp
        };
    }


    // ============================================================
    // ACCEPT ANSWER
    // ============================================================

    async acceptAnswer(
        answer:
            RTCSessionDescriptionInit
    ): Promise<void> {

        if (!answer.sdp) {

            throw new Error(
                'WebRTC answer has no SDP.'
            );
        }


        /*
         * Android native.
         */

        if (this.nativeAndroid) {

            this.requireNativePeer();


            await NativeWebRtc
                .acceptAnswer({
                    sdp:
                        answer.sdp
                });


            this.nativeRemoteDescriptionSet =
                true;


            await this
                .flushPendingIceCandidates();


            console.log(
                '★★★★★ [WEBRTC NATIVE] REMOTE ANSWER ACCEPTED ★★★★★'
            );


            return;
        }


        /*
         * Browser.
         */

        const peer =
            this.requireBrowserPeerConnection();


        await peer.setRemoteDescription(
            answer
        );


        await this
            .flushPendingIceCandidates();
    }


    // ============================================================
    // ADD ICE CANDIDATE
    // ============================================================

    async addIceCandidate(
        candidate:
            RTCIceCandidateInit
    ): Promise<void> {

        console.log(
            '★★★★★ [WEBRTC] REMOTE ICE CANDIDATE RECEIVED ★★★★★'
        );


        /*
         * =====================================================
         * ANDROID NATIVE
         * =====================================================
         */

        if (this.nativeAndroid) {

            this.requireNativePeer();


            /*
             * Exactly like browser:
             *
             * ICE may arrive over SignalR BEFORE SDP.
             *
             * Queue it until remote description is installed.
             */

            if (
                !this.nativeRemoteDescriptionSet
            ) {

                console.log(
                    '★★★★★ [WEBRTC NATIVE] QUEUING ICE - remote SDP not set yet ★★★★★'
                );


                this.pendingIceCandidates.push(
                    candidate
                );

                return;
            }


            await this
                .addNativeIceCandidate(
                    candidate
                );


            return;
        }


        /*
         * =====================================================
         * BROWSER
         * =====================================================
         */

        const peer =
            this.requireBrowserPeerConnection();


        if (!peer.remoteDescription) {

            console.log(
                '★★★★★ [WEBRTC BROWSER] QUEUING ICE - remote SDP not set yet ★★★★★'
            );


            this.pendingIceCandidates.push(
                candidate
            );

            return;
        }


        await peer.addIceCandidate(
            candidate
        );
    }


    // ============================================================
    // FLUSH ICE
    // ============================================================

    private async flushPendingIceCandidates():
        Promise<void> {

        if (
            this.pendingIceCandidates.length === 0
        ) {

            return;
        }


        const candidates =
            this.pendingIceCandidates
                .splice(0);


        /*
         * Android.
         */

        if (this.nativeAndroid) {

            if (
                !this.nativeRemoteDescriptionSet
            ) {

                /*
                 * Should not normally happen.
                 * Put them back rather than losing them.
                 */

                this.pendingIceCandidates
                    .unshift(
                        ...candidates
                    );

                return;
            }


            for (
                const candidate of
                candidates
            ) {

                await this
                    .addNativeIceCandidate(
                        candidate
                    );
            }


            return;
        }


        /*
         * Browser.
         */

        const peer =
            this.requireBrowserPeerConnection();


        if (!peer.remoteDescription) {

            this.pendingIceCandidates
                .unshift(
                    ...candidates
                );

            return;
        }


        for (
            const candidate of
            candidates
        ) {

            await peer.addIceCandidate(
                candidate
            );
        }
    }


    private async addNativeIceCandidate(
        candidate:
            RTCIceCandidateInit
    ): Promise<void> {

        if (!candidate.candidate) {

            return;
        }


        /*
         * sdpMLineIndex should be present in candidates
         * generated by RTCPeerConnection.
         */

        const sdpMLineIndex =
            candidate.sdpMLineIndex;


        if (
            sdpMLineIndex === null ||
            sdpMLineIndex === undefined
        ) {

            throw new Error(
                'ICE candidate has no sdpMLineIndex.'
            );
        }


        await NativeWebRtc
            .addIceCandidate({

                candidate:
                    candidate.candidate,

                sdpMid:
                    candidate.sdpMid,

                sdpMLineIndex
            });
    }


    // ============================================================
    // MICROPHONE
    // ============================================================

    async setMicrophoneEnabled(
        enabled: boolean
    ): Promise<void> {

        /*
         * Android.
         *
         * Enables/disables the WebRTC AudioTrack.
         *
         * The microphone itself is still owned exclusively
         * by JavaAudioDeviceModule.
         */

        if (this.nativeAndroid) {

            this.requireNativeInitialized();


            await NativeWebRtc
                .setMicrophoneEnabled({
                    enabled
                });


            return;
        }


        /*
         * Browser.
         */

        if (!this.localStream) {

            return;
        }


        for (
            const track of
            this.localStream
                .getAudioTracks()
        ) {

            track.enabled =
                enabled;
        }
    }


    // ============================================================
    // CAMERA
    // ============================================================

    async setCameraEnabled(
        enabled: boolean
    ): Promise<void> {

        if (this.nativeAndroid) {

            this.requireNativeInitialized();


            await NativeWebRtc
                .setCameraEnabled({
                    enabled
                });


            return;
        }


        if (!this.localStream) {

            return;
        }


        for (
            const track of
            this.localStream
                .getVideoTracks()
        ) {

            track.enabled =
                enabled;
        }
    }


    // ============================================================
    // SWITCH CAMERA
    // ============================================================

    async switchCamera():
        Promise<void> {

        if (this.nativeAndroid) {

            this.requireNativeInitialized();


            await NativeWebRtc
                .switchCamera();


            return;
        }


        /*
         * Browser camera switching is intentionally not
         * implemented here yet because the current UI does
         * not expose a switch-camera button.
         *
         * Android native implementation already supports it.
         */
    }


    // ============================================================
    // END CALL
    // ============================================================

    async endCall():
        Promise<void> {

        console.log(
            '★★★★★ [WEBRTC] END CALL ★★★★★'
        );


        /*
         * =====================================================
         * ANDROID
         * =====================================================
         *
         * closePeerConnection() closes the call but keeps
         * NativeWebRtc initialized.
         *
         * Camera + ADM therefore remain available if another
         * call is started.
         *
         * Full release is done separately.
         */

        if (this.nativeAndroid) {

            if (
                this.nativePeerCreated
            ) {

                await NativeWebRtc
                    .closePeerConnection();
            }


            this.nativePeerCreated =
                false;

            this.nativeRemoteDescriptionSet =
                false;

            this.pendingIceCandidates =
                [];

            this.iceCandidateHandler =
                undefined;

            this.nativeRemoteVideoAvailable.set(
                false
            );

            this.remoteMediaStream.set(
                null
            );

            this.localMediaStream.set(
                null
            );

            this.callConnected.set(
                false
            );

            this.callState.set(
                'closed'
            );


            return;
        }


        /*
         * =====================================================
         * BROWSER
         * =====================================================
         */

        this.peerConnection
            ?.close();


        this.peerConnection =
            undefined;


        if (
            this.localStream
        ) {

            for (
                const track of
                this.localStream
                    .getTracks()
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

        this.iceCandidateHandler =
            undefined;
    }


    // ============================================================
    // FULL NATIVE RELEASE
    // ============================================================

    async release():
        Promise<void> {

        /*
         * Browser endCall already releases browser media.
         */

        if (!this.nativeAndroid) {

            await this.endCall();

            return;
        }


        console.log(
            '★★★★★ [WEBRTC NATIVE] FULL RELEASE ★★★★★'
        );


        /*
         * NativeWebRtc.release():
         *
         * PeerConnection
         * camera capturer
         * VideoTrack
         * VideoSource
         * SurfaceTextureHelper
         * AudioTrack
         * AudioSource
         * PeerConnectionFactory
         * JavaAudioDeviceModule
         * EGL
         */

        if (
            this.nativeInitialized
        ) {

            await NativeWebRtc
                .release();
        }


        this.nativeInitialized =
            false;

        this.nativePeerCreated =
            false;

        this.nativeRemoteDescriptionSet =
            false;


        this.pendingIceCandidates =
            [];

        this.iceCandidateHandler =
            undefined;


        this.nativeLocalVideoAvailable.set(
            false
        );

        this.nativeRemoteVideoAvailable.set(
            false
        );


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
    }


    // ============================================================
    // NATIVE INITIALIZATION
    // ============================================================

    private async ensureNativeInitialized():
        Promise<void> {

        if (
            this.nativeInitialized
        ) {

            return;
        }


        console.log(
            '★★★★★ [WEBRTC NATIVE] INITIALIZING CAMERA + MICROPHONE ★★★★★'
        );


        await this
            .installNativeListeners();


        const result =
            await NativeWebRtc
                .initialize();


        if (
            !result.initialized
        ) {

            throw new Error(
                'Native WebRTC initialization failed.'
            );
        }


        this.nativeInitialized =
            true;


        /*
         * Native initialize() creates local VideoTrack.
         */

        this.nativeLocalVideoAvailable.set(
            true
        );


        console.log(
            '★★★★★ [WEBRTC NATIVE] INITIALIZED ★★★★★'
        );
    }


    // ============================================================
    // NATIVE LISTENERS
    // ============================================================

    private async installNativeListeners():
        Promise<void> {

        if (
            this.nativeListenersInstalled
        ) {

            return;
        }


        /*
         * -----------------------------------------------------
         * ICE
         * -----------------------------------------------------
         */

        this.nativeListenerHandles.push(

            await NativeWebRtc.addListener(
                'iceCandidate',
                candidate => {

                    console.log(
                        '★★★★★ [WEBRTC NATIVE] LOCAL ICE CANDIDATE ★★★★★'
                    );


                    this.iceCandidateHandler?.({

                        candidate:
                            candidate.candidate,

                        sdpMid:
                            candidate.sdpMid ?? null,

                        sdpMLineIndex:
                            candidate.sdpMLineIndex
                    });
                }
            )
        );


        /*
         * -----------------------------------------------------
         * CONNECTION STATE
         * -----------------------------------------------------
         */

        this.nativeListenerHandles.push(

            await NativeWebRtc.addListener(
                'connectionStateChanged',
                event => {

                    const state =
                        this.normalizeNativeConnectionState(
                            event.state
                        );


                    console.log(
                        '★★★★★ [WEBRTC NATIVE] CONNECTION STATE:',
                        state,
                        '★★★★★'
                    );


                    this.callState.set(
                        state
                    );


                    this.callConnected.set(
                        state === 'connected'
                    );
                }
            )
        );


        /*
         * -----------------------------------------------------
         * ICE CONNECTION STATE
         * -----------------------------------------------------
         */

        this.nativeListenerHandles.push(

            await NativeWebRtc.addListener(
                'iceConnectionStateChanged',
                event => {

                    console.log(
                        '★★★★★ [WEBRTC NATIVE] ICE CONNECTION STATE:',
                        event.state,
                        '★★★★★'
                    );
                }
            )
        );


        /*
         * -----------------------------------------------------
         * REMOTE VIDEO
         * -----------------------------------------------------
         */

        this.nativeListenerHandles.push(

            await NativeWebRtc.addListener(
                'remoteVideoTrackAvailable',
                event => {

                    console.log(
                        '★★★★★ [WEBRTC NATIVE] REMOTE VIDEO TRACK AVAILABLE:',
                        event.available,
                        '★★★★★'
                    );


                    this.nativeRemoteVideoAvailable.set(
                        event.available
                    );


                    /*
                     * IMPORTANT:
                     *
                     * Do NOT create a fake MediaStream here.
                     *
                     * The real native VideoTrack will be connected
                     * to SurfaceViewRenderer in the renderer step.
                     */
                }
            )
        );


        /*
         * -----------------------------------------------------
         * ERROR
         * -----------------------------------------------------
         */

        this.nativeListenerHandles.push(

            await NativeWebRtc.addListener(
                'error',
                event => {

                    console.error(
                        '★★★★★ [WEBRTC NATIVE] ERROR:',
                        event.message,
                        '★★★★★'
                    );
                }
            )
        );


        this.nativeListenersInstalled =
            true;
    }


    // ============================================================
    // REQUIRE NATIVE
    // ============================================================

    private requireNativeInitialized():
        void {

        if (
            !this.nativeInitialized
        ) {

            throw new Error(
                'Native WebRTC has not been initialized.'
            );
        }
    }


    private requireNativePeer():
        void {

        this.requireNativeInitialized();


        if (
            !this.nativePeerCreated
        ) {

            throw new Error(
                'Native WebRTC PeerConnection has not been created.'
            );
        }
    }


    // ============================================================
    // REQUIRE BROWSER PEER
    // ============================================================

    private requireBrowserPeerConnection():
        RTCPeerConnection {

        if (
            !this.peerConnection
        ) {

            throw new Error(
                'Browser WebRTC PeerConnection has not been initialized.'
            );
        }


        return this.peerConnection;
    }


    // ============================================================
    // NATIVE -> DOM STATE CONVERSION
    // ============================================================

    private normalizeNativeConnectionState(
        state: string
    ): RTCPeerConnectionState {

        switch (
        state.toLowerCase()
        ) {

            case 'new':
                return 'new';

            case 'connecting':
                return 'connecting';

            case 'connected':
                return 'connected';

            case 'disconnected':
                return 'disconnected';

            case 'failed':
                return 'failed';

            case 'closed':
                return 'closed';

            default:

                console.warn(
                    '[WEBRTC NATIVE] Unknown connection state:',
                    state
                );

                return 'new';
        }
    }

    async setNativeVideoLayout(
        remoteElement: HTMLElement,
        localElement: HTMLElement
    ): Promise<void> {

        if (!this.nativeAndroid) {
            return;
        }


        const remote =
            remoteElement.getBoundingClientRect();

        const local =
            localElement.getBoundingClientRect();


        await NativeWebRtc.setVideoLayout({

            pixelRatio:
                window.devicePixelRatio || 1,

            remote: {

                x:
                    remote.left,

                y:
                    remote.top,

                width:
                    remote.width,

                height:
                    remote.height,

                visible:
                    remote.width > 0 &&
                    remote.height > 0
            },

            local: {

                x:
                    local.left,

                y:
                    local.top,

                width:
                    local.width,

                height:
                    local.height,

                visible:
                    local.width > 0 &&
                    local.height > 0
            }
        });
    }


    async hideNativeVideoRenderers():
        Promise<void> {

        if (!this.nativeAndroid) {
            return;
        }


        await NativeWebRtc.hideVideoRenderers();
    }
}