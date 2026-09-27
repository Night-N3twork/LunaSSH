package lunassh

import (
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

// Transport is the internal browser bridge used to deliver Wisp/MoonBeam packets to Go SSH.
type Transport interface {
	io.ReadWriteCloser
	// LocalAddr returns the local network address
	LocalAddr() net.Addr
	// RemoteAddr returns the remote network address
	RemoteAddr() net.Addr
	// SetDeadline sets the read and write deadlines
	SetDeadline(t time.Time) error
	// SetReadDeadline sets the read deadline
	SetReadDeadline(t time.Time) error
	// SetWriteDeadline sets the write deadline
	SetWriteDeadline(t time.Time) error
}

// JSTransport wraps browser bridge callbacks for the Go SSH transport.
type JSTransport struct {
	id            string
	onWrite       func([]byte) error
	onClose       func() error
	readBuffer    []byte
	readChan      chan []byte
	closeChan     chan struct{}
	closed        bool
	terminalErr   error
	stage         sshConnectionStage
	postKeyWrites int
	mu            sync.Mutex
	localAddr     net.Addr
	remoteAddr    net.Addr
	readDeadline  time.Time
}

type sshConnectionStage string

const (
	sshConnectionStagePreKey   sshConnectionStage = "pre-key"
	sshConnectionStagePostKey  sshConnectionStage = "post-key"
	sshConnectionStageUserAuth sshConnectionStage = "userauth"

	wispCloseReasonStreamUnreachable uint8 = 0x42
)

// WispTransportCloseError is a terminal Wisp CLOSE diagnostic. It contains no
// remote payload, SSH packet bytes, or connection credentials.
type WispTransportCloseError struct {
	Reason uint8
	Stage  sshConnectionStage
}

func (e *WispTransportCloseError) Error() string {
	if e.Stage == sshConnectionStageUserAuth && e.Reason == 0x02 {
		return "remote SSH stream closed during user authentication: VOLUNTARY (0x02)"
	}
	return fmt.Sprintf("wisp transport closed during %s: %s (0x%02x)", e.Stage, wispCloseReasonName(e.Reason), e.Reason)
}

func wispCloseReasonName(reason uint8) string {
	switch reason {
	case 0x01:
		return "UNKNOWN"
	case 0x02:
		return "VOLUNTARY"
	case 0x03:
		return "NETWORK_ERROR"
	case 0x04:
		return "INCOMPATIBLE_EXTENSIONS"
	case 0x41:
		return "STREAM_INVALID_INFO"
	case 0x42:
		return "STREAM_UNREACHABLE"
	case 0x43:
		return "STREAM_TIMED_OUT"
	case 0x44:
		return "STREAM_REFUSED"
	case 0x47:
		return "TCP_DATA_TIMED_OUT"
	case 0x48:
		return "STREAM_BLOCKED"
	case 0x49:
		return "THROTTLED"
	case 0x81:
		return "CLIENT_ERROR"
	case 0xc0:
		return "AUTH_INVALID_PASSWORD"
	case 0xc1:
		return "AUTH_INVALID_SIGNATURE"
	case 0xc2:
		return "AUTH_REQUIRED"
	default:
		return "UNRECOGNIZED"
	}
}

// TransportAddr implements net.Addr for the browser bridge.
type TransportAddr struct {
	network string
	address string
}

func (a *TransportAddr) Network() string {
	return a.network
}

func (a *TransportAddr) String() string {
	return a.address
}

// NewJSTransport creates the internal browser bridge for Wisp/MoonBeam packets.
func NewJSTransport(id string, onWrite func([]byte) error, onClose func() error) *JSTransport {
	return &JSTransport{
		id:        id,
		onWrite:   onWrite,
		onClose:   onClose,
		readChan:  make(chan []byte, 100),
		closeChan: make(chan struct{}),
		localAddr: &TransportAddr{
			network: "js",
			address: "browser",
		},
		remoteAddr: &TransportAddr{
			network: "js",
			address: id,
		},
		stage: sshConnectionStagePreKey,
	}
}

// Read reads data from the transport
func (t *JSTransport) Read(p []byte) (n int, err error) {
	t.mu.Lock()
	if t.closed {
		err := t.terminalErr
		t.mu.Unlock()
		if err != nil {
			return 0, err
		}
		return 0, io.EOF
	}
	t.mu.Unlock()

	// If we have buffered data, return it first
	if len(t.readBuffer) > 0 {
		n = copy(p, t.readBuffer)
		t.readBuffer = t.readBuffer[n:]
		return n, nil
	}

	// Wait for new data or close
	var deadline <-chan time.Time
	t.mu.Lock()
	if !t.readDeadline.IsZero() {
		remaining := time.Until(t.readDeadline)
		if remaining <= 0 {
			t.mu.Unlock()
			return 0, errors.New("i/o timeout")
		}
		deadline = time.After(remaining)
	}
	t.mu.Unlock()
	select {
	case data := <-t.readChan:
		n = copy(p, data)
		if n < len(data) {
			// Buffer remaining data
			t.readBuffer = data[n:]
		}
		return n, nil
	case <-t.closeChan:
		t.mu.Lock()
		err := t.terminalErr
		t.mu.Unlock()
		if err != nil {
			return 0, err
		}
		return 0, io.EOF
	case <-deadline:
		return 0, errors.New("i/o timeout")
	}
}

// Write writes data to the transport
func (t *JSTransport) Write(p []byte) (n int, err error) {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return 0, errors.New("transport closed")
	}
	if t.stage == sshConnectionStagePostKey {
		t.postKeyWrites++
		// The first post-key write is SSH_MSG_NEWKEYS; the next begins userauth.
		if t.postKeyWrites >= 2 {
			t.stage = sshConnectionStageUserAuth
		}
	}
	t.mu.Unlock()

	if t.onWrite != nil {
		err = t.onWrite(p)
		if err != nil {
			return 0, err
		}
	}
	return len(p), nil
}

func (t *JSTransport) setConnectionStage(stage sshConnectionStage) {
	t.mu.Lock()
	t.stage = stage
	if stage == sshConnectionStagePostKey {
		t.postKeyWrites = 0
	}
	t.mu.Unlock()
}

// FailWispClose terminates reads with a redacted Wisp close diagnostic.
func (t *JSTransport) FailWispClose(reason uint8) {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return
	}
	t.closed = true
	t.terminalErr = &WispTransportCloseError{Reason: reason, Stage: t.stage}
	t.mu.Unlock()
	close(t.closeChan)
}

// Close closes the transport
func (t *JSTransport) Close() error {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil
	}
	t.closed = true
	t.mu.Unlock()

	close(t.closeChan)
	if t.onClose != nil {
		return t.onClose()
	}
	return nil
}

// InjectData injects data received from JavaScript into the transport
func (t *JSTransport) InjectData(data []byte) error {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return errors.New("transport closed")
	}
	t.mu.Unlock()

	select {
	case t.readChan <- data:
		return nil
	default:
		return errors.New("read buffer full")
	}
}

// LocalAddr returns the local network address
func (t *JSTransport) LocalAddr() net.Addr {
	return t.localAddr
}

// RemoteAddr returns the remote network address
func (t *JSTransport) RemoteAddr() net.Addr {
	return t.remoteAddr
}

// SetDeadline sets the read and write deadlines
func (t *JSTransport) SetDeadline(deadline time.Time) error {
	t.mu.Lock()
	t.readDeadline = deadline
	t.mu.Unlock()
	return nil
}

// SetReadDeadline sets the read deadline
func (t *JSTransport) SetReadDeadline(deadline time.Time) error {
	return t.SetDeadline(deadline)
}

// SetWriteDeadline sets the write deadline
func (t *JSTransport) SetWriteDeadline(time time.Time) error {
	// Not implemented for JS transport
	return nil
}

// TransportManager manages active browser bridge transports.
type TransportManager struct {
	transports map[string]*JSTransport
	mu         sync.RWMutex
}

var transportManager = &TransportManager{
	transports: make(map[string]*JSTransport),
}

// RegisterTransport registers a new transport
func RegisterTransport(id string, transport *JSTransport) {
	transportManager.mu.Lock()
	defer transportManager.mu.Unlock()
	transportManager.transports[id] = transport
}

// GetTransport retrieves a transport by ID
func GetTransport(id string) (*JSTransport, bool) {
	transportManager.mu.RLock()
	defer transportManager.mu.RUnlock()
	transport, ok := transportManager.transports[id]
	return transport, ok
}

// RemoveTransport removes a transport
func RemoveTransport(id string) {
	transportManager.mu.Lock()
	defer transportManager.mu.Unlock()
	delete(transportManager.transports, id)
}
