import vision from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3";

const { FaceLandmarker, FaceDetector, FilesetResolver, DrawingUtils, } = vision;
const demosSection = document.getElementById("demos");

class STATE {
    static INITIALIZING = "initializing";
    static CONNECTING_TO_SERVER = "connecting-to-server"
    static JOINING_QUEUE = "joining-queue";
    static CALLING = "calling";
    static WAITING_FOR_CALL = "waiting-for-call";

    static COUNTING_DOWN = "counting-down";
    static PLAYING = "playing";

    // We play a short animation here.
    static CALL_ENDED = "call-ended";

    static PRE_QUEUE = "pre-queue";
    static REJOIN_QUEUE = "rejoin-queue";
}

class BLINKSTATUS {
    static NOVIDEO = "no-video";
    static NONEWFRAME = "no-new-frame";
    static NOFACE = "no-face-found";
    static EYES_OPEN = "eyes-open";
    static EYES_CLOSED = "eyes-closed";
}

class WHO {
    static ME = "me";
    static THEM = "them";
}

class TERMINATION_REASON {
    static BLINKED = "blinked";
    static LOST_VIDEO = "lost-video";
    static LOST_FACE = "lost-face";
    static NO_STRANGER = "no-stranger";
    static DID_NOT_BLINK = "did-not-blink";

    // this should be a generic Error that takes a string :/
    // imagine having sum types (do not email me telling me to use typescript)
    static NO_WEBCAM = "no-webcam";
}

let localLandmarker;
let remoteLandmarker;
let faceDetector;
let peerConnection = new RTCPeerConnection();
let state = STATE.INITIALIZING;
let hackToAllowFadingDuringCountdown__DO_NOT_REENABLE_VIDEO = false;
let drawingHandler;
let strangerStaringCount = null;
var socket;
var room;
var uuid;

const BACKGROUND_LOAD_COLOR = "#240339";
const FOREGROUND_WIPE_COLOR = BACKGROUND_LOAD_COLOR;
const VIDEO_CUTOFF_TIME = 90000;
let videoCutoffId;
let refreshCutoffId;

const localVideo = document.getElementById("localVideo");
const localCanvas = document.getElementById("localCanvas");
const localUtils = new DrawingUtils(localCanvas.getContext("2d"));
const remoteVideo = document.getElementById("remoteVideo");
const cChime = document.getElementById("cChime");
const gChime = document.getElementById("gChime");
const readyChime = document.getElementById("readyChime");
const eyesClosedCheckbox = document.getElementById("eyesClosedCheckbox");

const footer = document.getElementById("footer");
const whatIsThisText = document.getElementById("whatIsThisText");
const whatIsThisBox = document.getElementById("whatIsThisBox");
const whatIsThisDismiss = document.getElementById("whatIsThisDismiss");
const dimOverlay = document.getElementById("dimOverlay");
const backgroundCanvas = document.getElementById("backgroundCanvas");
const foregroundCanvas = document.getElementById("foregroundCanvas");
const title = document.getElementById("title");
const titleText = document.getElementById("titleText");
const instructionsText = document.getElementById("instructionsText");
const instructionsBox = document.getElementById("instructionsBox");
const systemMessage = document.getElementById("systemMessage");
const enableWebcamButton = document.getElementById("webcamButton");

function sendSignal(signal) {
    signal.uuid = uuid;
    console.log(`Sending signal ${signal}`);
    socket.emit("signal", JSON.stringify(signal));
}

function closeOutPeerConnection() {
    if (peerConnection) {
        peerConnection.getSenders().forEach(sender => sender.track && sender.track.stop());
        peerConnection.getReceivers().forEach(receiver => receiver.track && receiver.track.stop());
        peerConnection.close();
        peerConnection = null;
    }
}

function endCallAtLimit() {
    videoCutoffId = setTimeout(function() {
        console.log("Video at cutoff, ending");
        endCall(WHO.ME, TERMINATION_REASON.DID_NOT_BLINK);
    }, VIDEO_CUTOFF_TIME);
}

function clearVideoCutoff() {
    if (videoCutoffId) {
        clearTimeout(videoCutoffId);
        videoCutoffId = null;
    }
}

function clearRefreshCutoff() {
    if (refreshCutoffId) {
        clearTimeout(refreshCutoffId);
        refreshCutoffId = null;
    }
}

function createNewPeerConnection(iceConfig, refreshTimeMs) {
    if (refreshTimeMs) {
        console.log(`will refresh at ${refreshTimeMs}`);
        const howLong = refreshTimeMs - Date.now();
        refreshCutoffId = setTimeout(function() {
            if (state === STATE.WAITING_FOR_CALL) {
                endCall(WHO.ME, TERMINATION_REASON.NO_STRANGER);
            }
        }, howLong);
    }

    peerConnection = new RTCPeerConnection(iceConfig);
    const localStream = localCanvas.captureStream(60); // FPS
    if (localStream.getVideoTracks().length > 0) {
        console.log("Adding track!");
        const track = localStream.getVideoTracks()[0];
        peerConnection.addTrack(track);
    } else {
        console.log("Couldn't get a track to add");
        endCall(WHO.ME, TERMINATION_REASON.NO_WEBCAM);
        return false;
    }

    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            sendSignal({"iceCandidate": event.candidate});
        }
    };

    peerConnection.onconnectionstatechange = event => {
        console.log(`connection state change: ${peerConnection.connectionState}`);
        switch(peerConnection.connectionState) {
            case "connected":
                transitionToState(STATE.COUNTING_DOWN);
                break;
            case "disconnected":
            case "failed":
            case "closed":
                // nroyalty: add retry logic
                console.warn("connection failed!");
                endCall(WHO.THEM, TERMINATION_REASON.LOST_VIDEO);
                break;
        }
    }

    peerConnection.ontrack = event => {
        if (event.streams && event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
        } else {
            var incomingStream = new MediaStream();
            incomingStream.addTrack(event.track);
            remoteVideo.srcObject = incomingStream;
        }
    };
}

function initWebSocket() {
    socket = io.connect();

    socket.on("role", (message) => {
        if (state !== STATE.JOINING_QUEUE) {
            console.warn("got ROLE message while not waiting for it! ignoring");
        } else if (message.role === "caller") {
            transitionToState(STATE.CALLING);
            createNewPeerConnection(message.iceConfig, null);
            startCall();
        } else if (message.role === "waiter") {
            transitionToState(STATE.WAITING_FOR_CALL);
            createNewPeerConnection(message.iceConfig, message.refreshTimeMs);
            waitForCall();
        }
    });

    function sendUuid() {
        socket.emit("register", { "uuid": uuid });
    }

    socket.on("connect", function() {
        if (state !== STATE.CONNECTING_TO_SERVER) {
            console.warn("Got 'connect' message but not waiting for it! Maybe we reconnected?");
        } else {
            console.log("connected to the server");
        }
        sendUuid();
    });

    socket.on("reconnect", function() {
        console.warn("reconnecting...");
        sendUuid();
    });

    socket.on("ack-register", (message) => {
        const was_connecting = (state === STATE.CONNECTING_TO_SERVER);
        if (was_connecting && !message.already_active) {
            console.log("registration succeeded");
            transitionToState(STATE.JOINING_QUEUE);
        } else if (was_connecting && message.already_active) {
            console.warn("registration succeeded but we were already active?");
            transitionToState(STATE.JOINING_QUEUE);
        } else if (!was_connecting && !message.already_active) {
            console.warn("Unexpected registration - we weren't connecting and weren't active on the server.");
        } else if (!was_connecting && message.already_active) {
            console.log("likely re-registration succeeded.");
        }
    });

    socket.on("signal", async (message) => {
        const data = JSON.parse(message);
        if (data.iceCandidate && (state === STATE.CALLING || state === STATE.WAITING_FOR_CALL)) {
            const candidate = new RTCIceCandidate(data.iceCandidate);
            peerConnection.addIceCandidate(candidate);
        } else if (data.iceCandidate) {
            console.info("Received an ice candidate after call was established");
            peerConnection.addIceCandidate(candidate);
        } else if (data.answer && state === STATE.CALLING) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        } else if (data.answer) {
            console.warn("Got 'answer' but not waiting for it?! Ignoring")
        } else if (data.offer && state === STATE.WAITING_FOR_CALL) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            sendSignal({ "answer": answer });
        } else if (data.offer) {
            console.warn("Got 'offer' but not waiting for it?! Ignoring")
        }
    });

    socket.on("stranger-exited", (message) => {
        console.log(`stranger exited ${message}`);
        if (state === STATE.PLAYING) {
            endCall(WHO.THEM, message.reason);
        } else {
            console.warn(`stranger-excited message while we aren't playing ${message}`);
        }
    });

    async function startCall() {
        try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            // Send the offer to the other peer using the signaling channel
            sendSignal({ 'offer': offer });
        } catch (error) {
            console.error('Error starting the call:', error);
        }
    }

    function waitForCall() {
        console.log("waiting for call....");
    }

    socket.on('users-connected', function(data) {
        if (strangerStaringCount === null) {
            strangerStaringCount = data.count;
            stareCountLoop();
        } else {
            strangerStaringCount = data.count;
        }
    });
}

function clearAndResizeCanvas(canvas) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

const BLINKED_THRESHOLD = 0.45;
/*
  Relevant categories are 9 and 10 (left and right blink) and maybe
  19 and 20 (left and right squint)

  0.45 is a relatively arbitrary threshold that seems to capture real blinks
  without being too noisy. I'm not sure whether false negatives or false positives
  are better.
*/
function blinkStatusForResults(results, do_log) {
    function maybe_log(text) {
        if (do_log) {
            console.log(text);
        }
    }

    if (results.faceBlendshapes && results.faceBlendshapes[0]) {
        maybe_log("have blendshapes");
        const categories = results.faceBlendshapes[0].categories;
        const logAlmostBlinks = false;
        if (logAlmostBlinks && (categories[9].score > 0.4 || categories[10].score > 0.4)) {
            console.debug(categories[9]);
            console.debug(categories[10]);
        }
        const leftBlink = categories[9].score;
        const rightBlink = categories[10].score;
        const value = (rightBlink + leftBlink) / 2.0;
        maybe_log(`${rightBlink} ${leftBlink} = ${value}`);
        if (eyesClosedCheckbox.checked || value >= BLINKED_THRESHOLD) {
            return BLINKSTATUS.EYES_CLOSED;
        } else {
            return BLINKSTATUS.EYES_OPEN;
        }
    } else {
        return BLINKSTATUS.NOFACE;
    }
}

function drawLandmarkMask(results, utils, startTimeMs) {
    if (results.faceLandmarks && results.faceLandmarks[0]) {
        const result = results.faceLandmarks[0];
        const fl = FaceLandmarker;
        function draw(landmarks, color, lineWidth) {
            for (const landmark of landmarks) {
                const options = { color };
                if (lineWidth !== undefined) {
                    options.lineWidth = lineWidth;
                }
                utils.drawConnectors(result, landmark, options);
            }
        }
        draw([fl.FACE_LANDMARKS_TESSELATION], "#C0C0C070", 1);
        draw([fl.FACE_LANDMARKS_RIGHT_EYE, fl.FACE_LANDMARKS_RIGHT_EYEBROW, fl.FACE_LANDMARKS_RIGHT_IRIS], "#FF3030");
        draw([fl.FACE_LANDMARKS_LEFT_EYE, fl.FACE_LANDMARKS_LEFT_EYEBROW, fl.FACE_LANDMARKS_LEFT_IRIS], "#30FF30");
        draw([fl.FACE_LANDMARKS_LIPS, fl.FACE_LANDMARKS_FACE_OVAL], "#E0E0E0");

        return true;
    }
    return false;

}

function videoReady(video) {
    return video.readyState >= 3 && !video.paused && (video.src || video.srcObject)
}

function cropFace(startTimeMs, copyToCanvas, cropFromVideo) {
    if (videoReady(cropFromVideo)) {
        const detections = faceDetector.detectForVideo(cropFromVideo, startTimeMs).detections;
        if (detections && detections[0]) {
            const detection = detections[0];
            const bb = detection && detection.boundingBox;
            if (bb) {
                const ctx = copyToCanvas.getContext("2d");
                const expandBy = 10;
                const originX = Math.max(0, bb.originX - expandBy);
                const originY = Math.max(0, bb.originY - expandBy * 2);
                let width = bb.width + expandBy * 2;
                width = Math.min(width, cropFromVideo.videoWidth - originX);
                let height = bb.height + expandBy * 4;
                height = Math.min(height, cropFromVideo.videoHeight - originY);

                const centerX = (copyToCanvas.width - width) / 2;
                const centerY = (copyToCanvas.height - height) / 2;
                ctx.drawImage(cropFromVideo, originX, originY, width, height, centerX, centerY, width, height);
                return true;
            }
        }
    }
    return false;
}

let lastLocalCamTime = -1;
function cropLocalVideoAndGetBlinkStatus() {
    if (!videoReady(localVideo)) {
        return BLINKSTATUS.NOVIDEO;
    } else if (lastLocalCamTime === localVideo.currentTime) {
        return BLINKSTATUS.NONEWFRAME;
    } else {
        let startTimeMs = performance.now();
        lastLocalCamTime = localVideo.currentTime;

        clearAndResizeCanvas(localCanvas);
        const foundFace = cropFace(startTimeMs, localCanvas, localVideo);
        if (!foundFace) {
            console.warn("Could not find a face!");
            var ctx = localCanvas.getContext('2d'); // Get the 2D context of the canvas
            ctx.fillStyle = 'rgb(153, 0, 0)'; // This is a more subdued red
            ctx.fillRect(0, 0, localCanvas.width, localCanvas.height);
            return BLINKSTATUS.NOFACE;
        }
        // nroyalty: Bail if we haven't found a face??
        const results = localLandmarker.detectForVideo(localVideo, startTimeMs);
        //const drewLandmarks = drawLandmarkMask(results, localUtils, startTimeMs);
        return blinkStatusForResults(results, false);
    }
}

let lastRemoteCamTime = -1;
function handleRemoteVideoAndGetBlinkStatus() {
    if (!videoReady(remoteVideo)) {
        return BLINKSTATUS.NOVIDEO;
    } else if (lastRemoteCamTime === remoteVideo.currentTime) {
        return BLINKSTATUS.NONEWFRAME;
    } else {
        let startTimeMs = performance.now();
        lastRemoteCamTime = remoteVideo.currentTime;
        const results = remoteLandmarker.detectForVideo(remoteVideo, startTimeMs);
        return blinkStatusForResults(results, false);
    }
}

function displayVideo(videoToDisplay, blinkStatus, videoToHide) {
    const isHidden = videoToDisplay.classList.contains("hidden");
    const isTransparent = videoToDisplay.classList.contains("transparent");

    if (isHidden) {
        // We've just swapped to this video.
        videoToDisplay.classList.remove("hidden");
        videoToHide.classList.add("hidden");
        // Add this now so that we can fade the video back in later.
        videoToHide.classList.add("transparent");
    }

    if (isTransparent && !hackToAllowFadingDuringCountdown__DO_NOT_REENABLE_VIDEO) {
        // Only start fading the video in when there's something to display
        // We want to fade the video at the end of the countdown, so don't remove
        // transparency in that case.
        if (blinkStatus === BLINKSTATUS.NOVIDEO
            || blinkStatus === BLINKSTATUS.NONEWFRAME
            || blinkStatus === BLINKSTATUS.NOFACE) {
            // Not yet!
        } else {
            videoToDisplay.classList.remove("transparent");
        }
    }
}

function showTitle(text) {
    if (titleText.innerHTML != text) {
        titleText.innerHTML = text;
    }
}

function stareText() {
    return `${strangerStaringCount} strangers staring`;
}

let amUpdatingStareCount = false;
function updateStareCount() {
    if (amUpdatingStareCount) {
        return;
    }
    amUpdatingStareCount = true;

    function scaleDown() {
        systemMessage.classList.remove("scale-y-up");
        systemMessage.classList.add("scale-y-down");
    }

    function scaleUp() {
        systemMessage.classList.remove("scale-y-down");
        systemMessage.classList.add("scale-y-up");
    }

    if (systemMessage.textContent !== stareText()) {
        scaleDown();
        setTimeout(function() {
            systemMessage.textContent = stareText();
            scaleUp();}, 500);
    }
    amUpdatingStareCount = false;
}

function stareCountLoop() {
    if (systemMessage.classList.contains("scale-y-down-fixed")) {
        // first run
        systemMessage.textContent = stareText();
        systemMessage.classList.remove("scale-y-down-fixed");
        systemMessage.classList.add("scale-y-up");
    } else {
        updateStareCount();
    }
    setTimeout(stareCountLoop, 5000);
}

function showInstructions(text) {
    instructionsText.classList.remove("transparent");

    if (instructionsText.classList.contains("hidden") && !instructionsText.alreadyShowing) {
        let diff = instructionsText.safeToShow - performance.now();
        diff = Math.max(0, diff);

        setTimeout(function() {
            instructionsText.classList.remove("hidden");
            instructionsText.style.display = "inline-block";
            instructionsText.style.animation = "fadeIn 1.0s ease-out";
            enableWebcamButton.style.display = "none";
        }, diff);
        instructionsText.alreadyShowing = true;
    }

    if (instructionsText.innerHTML != text) {
        instructionsText.innerHTML = text;
    }
}

let typeWriterState = { playing: false, fullString: "" };
function startTypewriterAnimation(fullString) {
    if (typeWriterState.fullString === fullString && typeWriterState.playing) {
        return null;
    }

    typeWriterState.playing = true;
    typeWriterState.fullString = fullString;
    let loc = 0;
    let appending = true;
    const speed = 75;
    
    function f() {
        if (!typeWriterState.playing || fullString !== typeWriterState.fullString) {
            return null;
        }

        function applyDelta(delta) {
            let continueIncr = true;
            let inTag = false;
            while (continueIncr) {
                loc += delta;
                if (fullString[loc] === " ") {
                    continueIncr = true;
                } else if (fullString[loc] === "<" || fullString[loc] === ">") {
                    inTag = !inTag;
                    continueIncr = inTag;
                } else if (fullString[loc] === ">") {
                    continueIncr = true;
                    inTag = false;
                } else if (inTag) {
                    continueIncr = true;
                } else {
                    continueIncr = false;
                }
            }
        }

        const delta = appending ? 1 : -1;
        const end = appending ? fullString.length : 0;
        applyDelta(delta);
        showInstructions(fullString.substr(0, loc));
        appending = loc === end ? !appending : appending;
        setTimeout(f, speed);
    }
    f();
}

function pulseTitle(small) {
    const c = small ? "pulse-countdown-small" : "pulse-countdown-large";

    titleText.classList.add(c);
    setTimeout(function() {
        titleText.classList.remove(c);
    }, 800);
}

function startCountdown(n) {
    if (n === 0) {
        cChime.play();
        transitionToState(STATE.PLAYING);
    } else if (n === 4) {
        // We don't play audio or display a title here - this second is
        // just so that our readyChime definitely finishes playing.
        // We could try to be clever and check if it ended and wait a second
        // if so, but eh.
        instructionsText.classList.add("transparent");
        setTimeout(function() { startCountdown(n - 1)}, 1000);
    } else {
        instructionsText.classList.add("transparent");
        if ((n % 2) === 1) {
            gChime.play();
        } else {
            cChime.play();
        }
        if (n === 1) {
            hackToAllowFadingDuringCountdown__DO_NOT_REENABLE_VIDEO = true;
            localCanvas.classList.add("transparent");
        }
        showTitle(`${n}`);
        pulseTitle(false);
        setTimeout(function() {startCountdown(n - 1)}, 1000);
    }
}

let eyesClosedStartTime = -1;
let eyesClosedLongEnoughToJoinQueue = false;
let timeOfFirstFrameFromStranger = -1;
let timeOfLastFrameFromStranger = -1;
let strangerConnectionStartTime = -1;
let playedReadyChime = false;
let callEndedCanDisplayVideo = 0;
// nroyalty: just convert these to millis??
const QUEUE_JOIN_THRESHOLD = 1.5;
// nroyalty: ideally we can find a way to only move to the "no video" threshold after the *second* frame
const STRANGER_NO_VIDEO_THRESHOLD = 5.0; // Seconds
const STRANGER_CONNECTION_THRESHOLD = 10.0; // Seconds
const START_CHECKING_FOR_BLINK_THRESHOLD = 0.75; // Seconds
const CONNECTING_ANIMATION_STATES = new Set([STATE.CALLING, STATE.WAITING_FOR_CALL, STATE.JOINING_QUEUE]);

// Ensure we log state transitions + add any one-time transition hooks here.
async function transitionToState(target) {
    console.log(`state transition (from: ${state}) -> (to: ${target})`);
    const oldState = state;
    state = target;

    if (state === STATE.CONNECTING_TO_SERVER) {
        await initWebSocket();
    } else if (oldState === STATE.CONNECTING_TO_SERVER) {
        updateStareCount();
    }

    if (oldState === STATE.PRE_QUEUE || oldState === STATE.CALL_ENDED) {
        playedReadyChime = false;
    }

    if (CONNECTING_ANIMATION_STATES.has(state)) {
        updateStareCount();
        const fullString = `connecting to <span class="highlight-secondary thick">stranger...</span>`
        startTypewriterAnimation(fullString);
    } else if (CONNECTING_ANIMATION_STATES.has(oldState)) {
        typeWriterState.playing = false;
    }

    if (state === STATE.COUNTING_DOWN) {
        startCountdown(4);
    } else if (oldState === STATE.COUNTING_DOWN) {
        titleText.classList.remove("pulse-countdown");
        hackToAllowFadingDuringCountdown__DO_NOT_REENABLE_VIDEO = false;
    }


    function clearQueueState() {
        eyesClosedLongEnoughToJoinQueue = false;
        timeOfLastFrameFromStranger = -1;
        strangerConnectionStartTime = performance.now() / 1000;
        eyesClosedStartTime = -1;
        timeOfFirstFrameFromStranger = -1;
    }

    if (state === STATE.PLAYING) {
        showTitle('look at this <span class="highlight-secondary">stranger</span>');
        endCallAtLimit();
        clearQueueState();
        clearRefreshCutoff();
        pulseTitle(true);
    }

    if (state === STATE.JOINING_QUEUE) {
        socket.emit("request-role", {"uuid": uuid});
    }

    if (state === STATE.CALL_ENDED) {
        clearVideoCutoff();

        if (oldState === STATE.WAITING_FOR_CALL) {
            // We bailed out of the queue
            clearQueueState();
        }

        callEndedCanDisplayVideo = performance.now() + 500;
        drawingHandler.beginEndscreen(1000);

        setTimeout(function() {
            transitionToState(STATE.REJOIN_QUEUE);
        }, 1100);

        // nroyalty: think about this.
        // This blink status is a lie, but we want something that fades the face back in.
        displayVideo(localCanvas, BLINKSTATUS.NOVIDEO, remoteVideo);
    } 

    if (state === STATE.REJOIN_QUEUE) {
        updateStareCount();
    }
}

async function endCall(who, reason) {
    let title = "something weird happened";

    if (who === WHO.ME && reason === TERMINATION_REASON.BLINKED) {
        title = "you blinked";
    } else if (who === WHO.THEM && reason === TERMINATION_REASON.BLINKED) {
        title = "the stranger blinked";
    } else if (who === WHO.ME && reason === TERMINATION_REASON.LOST_VIDEO) {
        title = "error with your video connection";
    } else if (who === WHO.THEM && reason === TERMINATION_REASON.LOST_VIDEO) {
        title = "the stranger lost video";
    } else if (who === WHO.ME && reason === TERMINATION_REASON.LOST_FACE) {
        title = "lost track of your face";
    } else if (who === WHO.THEM && reason === TERMINATION_REASON.LOST_FACE) {
        title = "the stranger hid their face";
    } else if (who === WHO.ME && reason === TERMINATION_REASON.NO_WEBCAM) {
        title = "error with your webcam (refresh?)";
    } else if (who === WHO.THEM && reason === TERMINATION_REASON.NO_WEBCAM) {
        title = "the stranger lost video";
    } else if (who === WHO.ME && reason === TERMINATION_REASON.NO_STRANGER) {
        title = "no stranger was available";
    } else if (who === WHO.ME && reason === TERMINATION_REASON.DID_NOT_BLINK) {
        title = '<span class="highlight-secondary thick">wow,</span> nobody blinked';
    }else {
        console.warn(`Unexpected endcall ${who} ${reason}`);
    }

    showTitle(title);
    transitionToState(STATE.CALL_ENDED);
    socket.emit("game-finished", { "uuid": uuid, "who": who, "reason": reason });
    closeOutPeerConnection();
}

class DrawingHandler {
    static DEBOUNCE_THRESHOLD = 0.15;
    static STATE_NOTHING = "no-animation";
    static STATE_LOADSCREEN = "loadscreen";
    static STATE_ENDSCREEN = "endscreen";

    clearLoadingState() {
        this.loadingStartingHeight = 0;
        this.loadingCurrentHeight = 0;
        this.loadingForwards = true;
        this.loadingStartTime = 0;
        this.loadingTargetAnimationTime = 0;
    }

    constructor(background, foreground) {
        this.background = background;
        this.foreground = foreground;
        this.ctxb = background.getContext("2d");
        this.ctxf = foreground.getContext("2d");
        this.currentState = DrawingHandler.STATE_NOTHING;
        this.clearLoadingState();

        this.drawLoadingScreen = this.drawLoadingScreen.bind(this);
        this.drawEndscreen = this.drawEndscreen.bind(this);
    }

    transitionToState(toState) {
        const NOTHING = DrawingHandler.STATE_NOTHING;
        const LOADING = DrawingHandler.STATE_LOADSCREEN;
        const ENDING  = DrawingHandler.STATE_ENDSCREEN;

        const oldState = this.currentState;
        this.currentState = toState;

        if (oldState === LOADING && toState === ENDING) {
            console.warn("Unexpected transition loading -> ending!");
            this.clearLoadingState();
        }
    }

    // these measurements *should* be the same for both...
    height() {
        return this.background.height;
    }

    width() {
        return this.background.width;
    }

    clearCanvas() {
        this.ctxf.clearRect(0, 0, this.width(), this.height());
        this.ctxb.clearRect(0, 0, this.width(), this.height());
    }

    beginLoad(speed, toTheTop) {
        this.loadingStartingHeight = this.loadingCurrentHeight;
        this.loadingStartTime = performance.now();
        this.loadingTargetAnimationTime = speed;
        this.loadingForwards = toTheTop;

        if (this.currentState !== DrawingHandler.STATE_LOADSCREEN) {
            this.transitionToState(DrawingHandler.STATE_LOADSCREEN);
            this.drawLoadingScreen(this.loadingStartTime);
        }
    }

    drawLoadingScreen(time) {
        if (this.currentState !== DrawingHandler.STATE_LOADSCREEN) {
            return;    
        }

        const timeElapsed = time - this.loadingStartTime;
        let actualProgress = timeElapsed / this.loadingTargetAnimationTime;
        // nroyalty: debounce
        actualProgress = Math.max(0, Math.min(actualProgress, 1));
        let progress;
        const DEBOUNCE_THRESHOLD = DrawingHandler.DEBOUNCE_THRESHOLD;

        if (actualProgress <= DEBOUNCE_THRESHOLD) {
            progress = 0;
        } else {
            progress = (actualProgress - DEBOUNCE_THRESHOLD) / (1 - DEBOUNCE_THRESHOLD);
        }

        let heightThisFrame;
        if (this.loadingForwards) {
            const fullDelta = this.height() - this.loadingStartingHeight;
            heightThisFrame = this.loadingStartingHeight + fullDelta * progress;
        } else {
            heightThisFrame = this.loadingStartingHeight * (1 - progress);
        }

        this.clearCanvas();
        this.ctxb.fillStyle = BACKGROUND_LOAD_COLOR;
        this.ctxb.fillRect(0, this.height(), this.width(), -heightThisFrame);
        this.loadingCurrentHeight = heightThisFrame;

        if (progress < 1) {
            window.requestAnimationFrame(this.drawLoadingScreen);
        } else {
            this.transitionToState(DrawingHandler.STATE_NOTHING);
        }
    }

    beginEndscreen(speed) {
        if (this.currentState === DrawingHandler.STATE_ENDSCREEN) {
            console.warn("Potential bug - beginEndscreen called twice!");
            return;
        }

        this.transitionToState(DrawingHandler.STATE_ENDSCREEN);
        this.endingStartTime = performance.now();
        // animation plays in and out.
        this.endingTargetAnimationTime = speed / 2;
        this.endingMovingForward = true;

        this.drawEndscreen(this.endingStartTime);
    }

    drawEndscreen(time) {
        if (this.currentState !== DrawingHandler.STATE_ENDSCREEN) {
            return;    
        }

        const timeElapsed = time - this.endingStartTime;
        let progress = timeElapsed / this.endingTargetAnimationTime;
        progress = Math.max(0, Math.min(progress, 1));
        
        const targetWidth = this.width() / 2;
        let widthThisFrame;

        if (this.endingMovingForward) {
            widthThisFrame = targetWidth * progress;
        } else {
            widthThisFrame = targetWidth * (1 - progress);
        }

        this.clearCanvas();
        this.ctxf.fillStyle = FOREGROUND_WIPE_COLOR;
        this.ctxf.fillRect(0, 0, widthThisFrame, this.height());
        this.ctxf.fillRect(this.width(), 0, -widthThisFrame, this.height());

        if (progress === 1 && this.endingMovingForward) {
            this.endingStartTime = time;
            this.endingMovingForward = false;
            window.requestAnimationFrame(this.drawEndscreen);
        } else if (progress === 1) {
            this.transitionToState(DrawingHandler.STATE_NOTHING);
        } else {
            window.requestAnimationFrame(this.drawEndscreen);
        }
    }
}

const closeYourEyes = '<span class="thick highlight-primary pulse-in">🙈 close your eyes</span> until you <span class="thick highlight-secondary">🔊 hear a chime</span>';
function promptToJoinQueue(nextState) {
    let now = performance.now();
    const blinkStatus = cropLocalVideoAndGetBlinkStatus();
    displayVideo(localCanvas, blinkStatus, remoteVideo);

    function maybeResetLoading() {
        if (eyesClosedStartTime !== -1) {
            // Our eyes *were* closed, loading had started.
            eyesClosedStartTime = -1;
            drawingHandler.beginLoad(500, false);
        }
    }
    let runUnloadAnimation = false;

    if (blinkStatus === BLINKSTATUS.NOVIDEO) {
        // This should only be shown when they haven't enabled their webcam,
        // which means the "enable webcam" button is visible.
        maybeResetLoading();
    } else if (blinkStatus === BLINKSTATUS.NONEWFRAME) {
        //maybeResetLoading();
        // Nothing to do.    
    } else if (blinkStatus === BLINKSTATUS.NOFACE) {
        maybeResetLoading();
        // nroyalty: ideally we could avoid showing this on the first run
        showInstructions("put your face on video");
    } else if (blinkStatus === BLINKSTATUS.EYES_OPEN) {
        // Don't match folks till they re-open their eyes!
        if (eyesClosedLongEnoughToJoinQueue) {
            drawingHandler.beginLoad(500, false);
            transitionToState(nextState);
        } else {
            maybeResetLoading();
            showInstructions(closeYourEyes);
        }
    } else if (blinkStatus === BLINKSTATUS.EYES_CLOSED) {
        if (eyesClosedStartTime === -1) {
            drawingHandler.beginLoad(QUEUE_JOIN_THRESHOLD * 1000, true);
            eyesClosedStartTime = now;
        }
        const deltaTime = (now - eyesClosedStartTime) / 1000;
        const timeRemaining = (QUEUE_JOIN_THRESHOLD - deltaTime).toFixed(1);
        if (timeRemaining <= 0) {
            showInstructions("open your eyes (how are you reading this?)");
            if (!playedReadyChime) {
                playedReadyChime = true;
                readyChime.play();
            }
            eyesClosedLongEnoughToJoinQueue = true;
            showTitle(`ready?`)
        } else {
            showInstructions(closeYourEyes);
        }
    } else {
        console.warn(`ERROR! Unexpected blink status ${blinkStatus} (next state: ${nextState})`);
    }
}

async function requestAnimationFrame(frameTime) {
    if (state == STATE.PRE_QUEUE) {
        promptToJoinQueue(STATE.CONNECTING_TO_SERVER)
    } else if  (state === STATE.CALL_ENDED) {
        // We're playing an animation here, no need to do much else
        // We trigger displayVideo once in the state transition so that the video fades.
        let now = performance.now();
        if (now >= callEndedCanDisplayVideo) {
            const s = cropLocalVideoAndGetBlinkStatus();
            displayVideo(localCanvas, s, remoteVideo);
        }
    } else if (state === STATE.REJOIN_QUEUE) {
        promptToJoinQueue(STATE.JOINING_QUEUE)
    } else if (state === STATE.CONNECTING_TO_SERVER) {
        const s = cropLocalVideoAndGetBlinkStatus();
        displayVideo(localCanvas, s, remoteVideo);
    } else if (state === STATE.JOINING_QUEUE) {
        const s = cropLocalVideoAndGetBlinkStatus();
        displayVideo(localCanvas, s, remoteVideo);
    } else if (state === STATE.CALLING || state === STATE.WAITING_FOR_CALL) {
        const s = cropLocalVideoAndGetBlinkStatus();
        displayVideo(localCanvas, s, remoteVideo);
    } else if (state === STATE.COUNTING_DOWN) {
        const s = cropLocalVideoAndGetBlinkStatus();
        displayVideo(localCanvas, s, remoteVideo);
        // nothing to do? 
    } else if (state === STATE.PLAYING) {
        // We have to do this here to ensure our local video transmits pre-cropped.
        // We could crop on the remote side but maybe people would assume you couldn't
        // Get at their backgrounds even if you wrote an alternate client?
        // I'm not sure. It would probably be easier....
        const localBlinkStatus = cropLocalVideoAndGetBlinkStatus();
        const remoteBlinkStatus = handleRemoteVideoAndGetBlinkStatus();
        displayVideo(remoteVideo, remoteBlinkStatus, localCanvas);
        const now = performance.now() / 1000;

        function shouldEndCallForNoVideo() {
            let diff, reason, threshold;
            if (timeOfLastFrameFromStranger === -1) {
                diff = now - strangerConnectionStartTime;
                threshold = STRANGER_CONNECTION_THRESHOLD;
                //console.log("never received video from stranger!");
                reason = TERMINATION_REASON.LOST_VIDEO;
            } else {
                diff = now - timeOfLastFrameFromStranger;
                threshold = STRANGER_NO_VIDEO_THRESHOLD
                //console.log("the stranger lost video");
                reason = TERMINATION_REASON.LOST_VIDEO;
            }
            return (diff >= threshold) ? reason : false; 
        }

        function haveFrameAndExceededThreshold(lastFrame, threshold) {
            const haveFrame = (timeOfFirstFrameFromStranger !== -1);
            const frameDiff = (now - lastFrame);
            return haveFrame && (frameDiff >= threshold);

        }

        function shouldEndOnBlink() {
            return haveFrameAndExceededThreshold(timeOfFirstFrameFromStranger, START_CHECKING_FOR_BLINK_THRESHOLD);
        }

        function shouldLogMissingVideoWarning() {
            return haveFrameAndExceededThreshold(timeOfLastFrameFromStranger, 0.5);
        }

        if (localBlinkStatus === BLINKSTATUS.NOVIDEO) {
            endCall(WHO.ME, TERMINATION_REASON.LOST_VIDEO);
        } else if (localBlinkStatus === BLINKSTATUS.NOFACE) {
            endCall(WHO.ME, TERMINATION_REASON.LOST_FACE);
        } else if (localBlinkStatus === BLINKSTATUS.EYES_CLOSED && shouldEndOnBlink()) {
            endCall(WHO.ME, TERMINATION_REASON.BLINKED);
        } else if (remoteBlinkStatus === BLINKSTATUS.NOVIDEO) {
            console.log("The stranger has no video");
            const result = shouldEndCallForNoVideo();
            if (result) {
                endCall(WHO.THEM, result);
            }
        } else if (remoteBlinkStatus === BLINKSTATUS.NOFACE) {
            console.log("The stranger hid their face");
            endCall(WHO.THEM, TERMINATION_REASON.LOST_FACE);
        } else if (remoteBlinkStatus === BLINKSTATUS.NONEWFRAME) {
            if (shouldLogMissingVideoWarning()) {
                console.log("The stranger's video is lagging or cut");
            }
            const result = shouldEndCallForNoVideo();
            if (result) {
                endCall(WHO.THEM, result);
            }
        } else {
            timeOfLastFrameFromStranger = now;
            if (timeOfFirstFrameFromStranger === -1) {
                timeOfFirstFrameFromStranger = now;
            }
            if (remoteBlinkStatus === BLINKSTATUS.EYES_CLOSED && shouldEndOnBlink()) {
                endCall(WHO.THEM, TERMINATION_REASON.BLINKED);
            } else {
                showInstructions(`<span class="highlight-primary thick">don't blink</span>`);
            }
        }
    }

    window.requestAnimationFrame(requestAnimationFrame);
}

async function createFaceLandmarker() {
    const filesetResolver = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
    );

    async function getLandmarker() { 
        return FaceLandmarker.createFromOptions(filesetResolver, {
            baseOptions: {
                modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
                delegate: "GPU"
            },
            outputFaceBlendshapes: true,
            runningMode : "VIDEO",
            numFaces: 1
        });
    }
    localLandmarker = await getLandmarker();
    remoteLandmarker = await getLandmarker();
}

const initializefaceDetector = async () => {
    const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
    );
    faceDetector = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite`,
            delegate: "GPU"
        },
        runningMode: "VIDEO"
    });
};

function wireUpWebcamButton() {
    const hasGetUserMedia = () => !!navigator.mediaDevices?.getUserMedia;
    if (hasGetUserMedia()) {
        enableWebcamButton.addEventListener("click", enableCam);
    } else {
        alert("Couldn't find your webcam. You need a webcam to use this site.");
    }
}

async function enableCam(event) {
    if (!localLandmarker || !remoteLandmarker) {
        alert("Face Detector is still loading. Please try again..");
        return;
    }

    enableWebcamButton.style.opacity = 1;
    enableWebcamButton.style.animation = "fall 0.5s forwards";
    enableWebcamButton.classList.add("button-pressed");
    instructionsBox.classList.remove("wiggle");
    instructionsText.safeToShow = performance.now() + 500;
    instructionsText.alreadyShowing = false;

    navigator.mediaDevices
        .getUserMedia({ video: true })
        .then(function (stream) {
            localVideo.srcObject = stream;
        })
        .catch((err) => {
            // nroyalty: Handle this error.
            console.error(err);
        });

    // mobile audio hacks :(
    readyChime.src = "/static/ready-chime-tense.mp3";
    cChime.src = "/static/c-chime.mp3";
    gChime.src = "/static/g-chime.mp3";
}

function setUpWhatIsThisPopup() {
    function toggleDisplay() {
        whatIsThisBox.classList.toggle("transparent");
        const isDisabled = whatIsThisBox.classList.contains("transparent");
        whatIsThisDismiss.disabled = isDisabled;

        if (isDisabled) {
            whatIsThisBox.classList.add("not-clickable");
            dimOverlay.classList.add("transparent");
        } else {
            whatIsThisBox.classList.remove("not-clickable");
            dimOverlay.classList.remove("transparent");
        }
    }

    whatIsThisText.addEventListener("click", toggleDisplay);
    whatIsThisDismiss.addEventListener("click", toggleDisplay);
}

async function initialize() {
    const flP = createFaceLandmarker();
    const dfP = initializefaceDetector();
    uuid = localStorage.getItem('mySiteUUID');
    // nroyalty: move to init code.
    if (!uuid) {
        uuid = crypto.randomUUID();
        localStorage.setItem('mySiteUUID', uuid);
    }
    wireUpWebcamButton();
    requestAnimationFrame();

    readyChime.volume = 0.4; // The chime I recorded is a little loud.
    cChime.volume = 0.5;
    gChime.volume = 0.5;

    // nroyalty: maybe we should add a timeout here and show an error message
    // if this await doesn't finish in like 10 seconds.
    setUpWhatIsThisPopup();
    drawingHandler = new DrawingHandler(backgroundCanvas, foregroundCanvas);

    await Promise.all([flP, dfP]);

    transitionToState(STATE.PRE_QUEUE);
    console.log("face detections loaded");
    const animations = "fadeIn 2s ease-in-out forwards, fallIn 1s ease-in-out forwards";
    title.style.animation = animations;
    enableWebcamButton.style.animation = animations;
    footer.style.animation = "fadeIn 2s ease-in-out forwards";
}
document.addEventListener('DOMContentLoaded', initialize);
