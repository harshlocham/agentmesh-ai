export type PeerManagerCallbacks = {
    onIceCandidate?: (candidate: RTCIceCandidate) => void;
    onTrack?: (event: RTCTrackEvent) => void;
    onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
};

export class PeerManager {
    private peerConnection: RTCPeerConnection | null = null;
    private pendingCandidates: RTCIceCandidateInit[] = [];

    constructor(
        private readonly config: RTCConfiguration,
        private readonly callbacks: PeerManagerCallbacks = {}
    ) {}

    createPeerConnection(): RTCPeerConnection {
        if (this.peerConnection) return this.peerConnection;

        const pc = new RTCPeerConnection(this.config);

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.callbacks.onIceCandidate?.(event.candidate);
            }
        };

        pc.ontrack = (event) => {
            this.callbacks.onTrack?.(event);
        };

        pc.onconnectionstatechange = () => {
            this.callbacks.onConnectionStateChange?.(pc.connectionState);
        };

        this.peerConnection = pc;
        return pc;
    }

    getPeerConnection(): RTCPeerConnection {
        return this.createPeerConnection();
    }

    async addLocalStream(stream: MediaStream): Promise<void> {
        const pc = this.getPeerConnection();
        for (const track of stream.getTracks()) {
            pc.addTrack(track, stream);
        }
    }

    async createOffer(): Promise<RTCSessionDescriptionInit> {
        const pc = this.getPeerConnection();
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        return offer;
    }

    async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
        const pc = this.getPeerConnection();
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.flushPendingCandidates();
        return answer;
    }

    async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
        const pc = this.getPeerConnection();
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        await this.flushPendingCandidates();
    }

    async handleICE(candidate: RTCIceCandidateInit): Promise<void> {
        const pc = this.getPeerConnection();
        if (!pc.remoteDescription) {
            this.pendingCandidates.push(candidate);
            return;
        }

        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }

    async restartIce(): Promise<RTCSessionDescriptionInit> {
        const pc = this.getPeerConnection();
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        return offer;
    }

    close(): void {
        if (!this.peerConnection) return;

        this.peerConnection.onicecandidate = null;
        this.peerConnection.ontrack = null;
        this.peerConnection.onconnectionstatechange = null;
        this.peerConnection.close();
        this.peerConnection = null;
        this.pendingCandidates = [];
    }

    private async flushPendingCandidates(): Promise<void> {
        if (!this.peerConnection || this.pendingCandidates.length === 0) return;

        const buffered = [...this.pendingCandidates];
        this.pendingCandidates = [];

        for (const candidate of buffered) {
            await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
    }
}
