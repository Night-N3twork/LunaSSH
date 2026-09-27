package lunassh

import (
	"bytes"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

type ConnectionOptions struct {
	Host                            string
	Port                            int
	User                            string
	Password                        string
	PrivateKey                      string
	Timeout                         int
	KnownHosts                      []string
	HostKeyFingerprint              string
	HostKey                         string
	InsecureSkipHostKeyVerification bool
	TrustOnFirstUse                 bool
}

type PacketCallback func(data []byte, metadata map[string]interface{})
type StateCallback func(state string)
type TerminalOutputCallback func(data []byte)

type Client struct {
	options          ConnectionOptions
	conn             *ssh.Client
	session          *ssh.Session
	sessionID        string
	mu               sync.RWMutex
	onPacketReceive  PacketCallback
	onPacketSend     PacketCallback
	onStateChange    StateCallback
	onAuthBanner     func(message string)
	onTerminalOutput TerminalOutputCallback
	transport        Transport
	stdin            chan []byte
	stdout           chan []byte
	shellStarted     bool
}

var (
	sessions   = make(map[string]*Client)
	sessionsMu sync.RWMutex
)

func New(options ConnectionOptions) *Client {
	return &Client{
		options:   options,
		sessionID: generateSessionID(),
		stdin:     make(chan []byte, 100),
		stdout:    make(chan []byte, 100),
	}
}

func connectionTimeout(seconds int) time.Duration {
	if seconds <= 0 {
		return 30 * time.Second
	}
	return time.Duration(seconds) * time.Second
}

type knownHostKey struct {
	hosts []string
	key   ssh.PublicKey
}

func hostKeyCallback(options ConnectionOptions) (ssh.HostKeyCallback, error) {
	if options.InsecureSkipHostKeyVerification {
		return ssh.InsecureIgnoreHostKey(), nil
	}
	knownKeys := make([]knownHostKey, 0, len(options.KnownHosts))
	for index, line := range options.KnownHosts {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			return nil, fmt.Errorf("invalid knownHosts entry %d: expected 'host key-type base64'", index+1)
		}
		key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(strings.Join(fields[1:], " ")))
		if err != nil {
			return nil, fmt.Errorf("invalid knownHosts entry %d: %w", index+1, err)
		}
		knownKeys = append(knownKeys, knownHostKey{hosts: strings.Split(fields[0], ","), key: key})
	}

	var pinnedKey ssh.PublicKey
	if options.HostKey != "" {
		key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(options.HostKey))
		if err != nil {
			return nil, fmt.Errorf("invalid hostKey: %w", err)
		}
		pinnedKey = key
	}

	return func(hostname string, _ net.Addr, presented ssh.PublicKey) error {
		for _, known := range knownKeys {
			if knownHostMatches(known.hosts, hostname) && publicKeysEqual(known.key, presented) {
				return nil
			}
		}
		if options.HostKeyFingerprint == ssh.FingerprintSHA256(presented) || options.HostKeyFingerprint == ssh.FingerprintLegacyMD5(presented) {
			return nil
		}
		if pinnedKey != nil && publicKeysEqual(pinnedKey, presented) {
			return nil
		}
		if options.TrustOnFirstUse || (len(knownKeys) == 0 && options.HostKeyFingerprint == "" && pinnedKey == nil) {
			return fmt.Errorf("unverified host key for %s: %s", hostname, ssh.FingerprintSHA256(presented))
		}
		return fmt.Errorf("host key verification failed for %s", hostname)
	}, nil
}

func validatedHostKeyCallback(callback ssh.HostKeyCallback, transport Transport) ssh.HostKeyCallback {
	return func(hostname string, remote net.Addr, presented ssh.PublicKey) error {
		if err := callback(hostname, remote, presented); err != nil {
			return err
		}
		if staged, ok := transport.(*JSTransport); ok {
			staged.setConnectionStage(sshConnectionStagePostKey)
		}
		return nil
	}
}

func knownHostMatches(patterns []string, hostname string) bool {
	host, port, hasPort := splitHostPort(hostname)
	for _, pattern := range patterns {
		if pattern == hostname {
			return true
		}
		if patternHost, patternPort, patternHasPort := splitHostPort(pattern); hasPort && patternHasPort && host == patternHost && port == patternPort {
			return true
		}
		if hasPort && pattern == host {
			return true
		}
	}
	return false
}

func splitHostPort(value string) (string, string, bool) {
	host, port, err := net.SplitHostPort(value)
	return host, port, err == nil
}

func publicKeysEqual(first, second ssh.PublicKey) bool {
	return first.Type() == second.Type() && bytes.Equal(first.Marshal(), second.Marshal())
}

// SetTransport sets the transport for the client
func (c *Client) SetTransport(transport Transport) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.transport = transport
}

func (c *Client) OnPacketReceive(callback PacketCallback) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onPacketReceive = callback
}

func (c *Client) OnPacketSend(callback PacketCallback) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onPacketSend = callback
}

func (c *Client) OnStateChange(callback StateCallback) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onStateChange = callback
}

func (c *Client) OnAuthBanner(callback func(message string)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onAuthBanner = callback
}

// OnTerminalOutput receives plaintext stdout and stderr from the remote shell.
// SSH transport packets remain available only through the packet callbacks.
func (c *Client) OnTerminalOutput(callback TerminalOutputCallback) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onTerminalOutput = callback
}

func (c *Client) Connect() (string, error) {
	c.notifyStateChange("connecting")
	hostKeyCallback, err := hostKeyCallback(c.options)
	if err != nil {
		c.notifyStateChange("error")
		return "", err
	}

	config := &ssh.ClientConfig{
		User:            c.options.User,
		HostKeyCallback: validatedHostKeyCallback(hostKeyCallback, c.transport),
		Timeout:         connectionTimeout(c.options.Timeout),
		BannerCallback: func(message string) error {
			c.mu.RLock()
			callback := c.onAuthBanner
			c.mu.RUnlock()
			if callback != nil {
				callback(message)
			}
			return nil
		},
	}

	if c.options.Password != "" {
		config.Auth = append(config.Auth, ssh.Password(c.options.Password))
	}

	if c.options.PrivateKey != "" {
		signer, err := ssh.ParsePrivateKey([]byte(c.options.PrivateKey))
		if err != nil {
			c.notifyStateChange("error")
			return "", fmt.Errorf("failed to parse private key: %v", err)
		}
		config.Auth = append(config.Auth, ssh.PublicKeys(signer))
	}

	// The transport should already be set before calling Connect
	if c.transport == nil {
		c.notifyStateChange("error")
		return "", fmt.Errorf("no transport configured")
	}

	// Create SSH connection over the transport
	addr := fmt.Sprintf("%s:%d", c.options.Host, c.options.Port)

	// Wrap transport with packet interceptor
	wrappedTransport := NewInterceptedTransport(c.transport, c.onPacketSend, c.onPacketReceive)
	deadline := time.Now().Add(connectionTimeout(c.options.Timeout))
	if err := wrappedTransport.SetDeadline(deadline); err != nil {
		c.notifyStateChange("error")
		return "", fmt.Errorf("failed to set SSH connection timeout: %v", err)
	}

	// Create SSH client connection using the transport
	sshConn, chans, reqs, err := ssh.NewClientConn(wrappedTransport, addr, config)
	if err != nil {
		c.notifyStateChange("error")
		return "", fmt.Errorf("failed to establish SSH connection: %v", err)
	}
	_ = wrappedTransport.SetDeadline(time.Time{})

	c.conn = ssh.NewClient(sshConn, chans, reqs)
	if err := c.StartShell(); err != nil {
		c.conn.Close()
		c.conn = nil
		c.notifyStateChange("error")
		return "", fmt.Errorf("failed to start interactive session: %v", err)
	}

	sessionsMu.Lock()
	sessions[c.sessionID] = c
	sessionsMu.Unlock()

	c.notifyStateChange("connected")

	return c.sessionID, nil
}

func (c *Client) StartShell() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.shellStarted {
		return nil // Shell already started
	}

	if c.conn == nil {
		return fmt.Errorf("not connected")
	}

	// Create a new session
	session, err := c.conn.NewSession()
	if err != nil {
		return fmt.Errorf("failed to create session: %v", err)
	}
	c.session = session
	defer func() {
		if !c.shellStarted {
			session.Close()
			c.session = nil
		}
	}()

	// Set up stdin pipe
	stdin, err := session.StdinPipe()
	if err != nil {
		return fmt.Errorf("failed to create stdin pipe: %v", err)
	}

	// Set up stdout pipe
	stdout, err := session.StdoutPipe()
	if err != nil {
		return fmt.Errorf("failed to create stdout pipe: %v", err)
	}

	// Set up stderr pipe (combine with stdout)
	stderr, err := session.StderrPipe()
	if err != nil {
		return fmt.Errorf("failed to create stderr pipe: %v", err)
	}

	// Request pseudo terminal
	modes := ssh.TerminalModes{
		ssh.ECHO:          1,     // enable echoing
		ssh.TTY_OP_ISPEED: 14400, // input speed = 14.4kbaud
		ssh.TTY_OP_OSPEED: 14400, // output speed = 14.4kbaud
	}

	if err := session.RequestPty("xterm-256color", 24, 80, modes); err != nil {
		return fmt.Errorf("request for pseudo terminal failed: %v", err)
	}

	// Start the remote shell
	if err := session.Shell(); err != nil {
		return fmt.Errorf("failed to start shell: %v", err)
	}

	c.shellStarted = true

	// Start goroutine to handle stdin
	input := c.stdin
	go func() {
		for data := range input {
			stdin.Write(data)
		}
	}()

	// Start goroutine to handle stdout
	go func() {
		buf := make([]byte, 1024)
		for {
			n, err := stdout.Read(buf)
			if err != nil {
				break
			}
			if n > 0 {
				data := make([]byte, n)
				copy(data, buf[:n])
				c.emitTerminalOutput(data)
			}
		}
	}()

	// Start goroutine to handle stderr
	go func() {
		buf := make([]byte, 1024)
		for {
			n, err := stderr.Read(buf)
			if err != nil {
				break
			}
			if n > 0 {
				data := make([]byte, n)
				copy(data, buf[:n])
				c.emitTerminalOutput(data)
			}
		}
	}()

	return nil
}

func (c *Client) emitTerminalOutput(data []byte) {
	c.mu.RLock()
	callback := c.onTerminalOutput
	c.mu.RUnlock()
	if callback != nil {
		callback(data)
	}
}

func (c *Client) Send(data []byte) error {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if !c.shellStarted {
		// Start shell on first send
		c.mu.RUnlock()
		err := c.StartShell()
		c.mu.RLock()
		if err != nil {
			return err
		}
	}

	// Send data to stdin channel
	select {
	case c.stdin <- data:
		if c.onPacketSend != nil {
			metadata := map[string]interface{}{
				"timestamp": time.Now().Unix(),
				"type":      "data",
				"direction": "send",
				"size":      len(data),
			}
			c.onPacketSend(data, metadata)
		}
		return nil
	default:
		return fmt.Errorf("stdin buffer full")
	}
}

func (c *Client) ResizeTerminal(cols, rows int) error {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if c.session == nil {
		return fmt.Errorf("no active session")
	}

	return c.session.WindowChange(rows, cols)
}

func (c *Client) Disconnect() error {
	c.notifyStateChange("disconnecting")

	c.mu.Lock()
	defer c.mu.Unlock()

	// Close stdin channel to stop goroutine
	if c.stdin != nil {
		close(c.stdin)
		c.stdin = nil
	}

	if c.session != nil {
		c.session.Close()
		c.session = nil
	}

	if c.conn != nil {
		c.conn.Close()
		c.conn = nil
	}

	c.shellStarted = false

	sessionsMu.Lock()
	delete(sessions, c.sessionID)
	sessionsMu.Unlock()

	c.notifyStateChange("disconnected")

	return nil
}

func (c *Client) notifyStateChange(state string) {
	if c.onStateChange != nil {
		c.onStateChange(state)
	}
}

func DisconnectSession(sessionID string) error {
	sessionsMu.RLock()
	client, exists := sessions[sessionID]
	sessionsMu.RUnlock()

	if !exists {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	return client.Disconnect()
}

func SendToSession(sessionID string, data []byte) error {
	sessionsMu.RLock()
	client, exists := sessions[sessionID]
	sessionsMu.RUnlock()

	if !exists {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	return client.Send(data)
}

func generateSessionID() string {
	return fmt.Sprintf("ssh-%d", time.Now().UnixNano())
}
