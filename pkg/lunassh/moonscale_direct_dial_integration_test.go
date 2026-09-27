package lunassh

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func TestMoonScaleDirectDialSSHIntegration(t *testing.T) {
	t.Run("pins host key authenticates opens a PTY shell exchanges data resizes and closes", func(t *testing.T) {
		server := newMoonScaleDirectDialSSHServer(t, moonScaleDirectDialSSHServerOptions{})
		defer server.Close()

		output := make(chan string, 2)
		client := New(ConnectionOptions{
			Host:               "100.64.0.10",
			Port:               22,
			User:               "alice",
			Password:           "correct-password",
			HostKeyFingerprint: server.HostKeyFingerprint(),
		})
		client.OnTerminalOutput(func(data []byte) { output <- string(data) })
		client.SetTransport(dialMoonScaleTCP(t, server.Addr()))

		if _, err := client.Connect(); err != nil {
			t.Fatalf("Connect() error = %v", err)
		}
		server.WaitForAuthentication(t, "correct-password")
		server.WaitForPTY(t, "xterm-256color", 80, 24)
		waitForTerminalOutput(t, output, "ready\n")
		if err := client.Send([]byte("ping\n")); err != nil {
			t.Fatalf("Send() error = %v", err)
		}
		server.WaitForInput(t, "ping\n")
		waitForTerminalOutput(t, output, "pong\n")
		if err := client.ResizeTerminal(120, 40); err != nil {
			t.Fatalf("ResizeTerminal() error = %v", err)
		}
		server.WaitForResize(t, 120, 40)
		if err := client.Disconnect(); err != nil {
			t.Fatalf("Disconnect() error = %v", err)
		}
		server.WaitForClientClose(t)
	})

	t.Run("rejects an unpinned host key before opening a shell", func(t *testing.T) {
		server := newMoonScaleDirectDialSSHServer(t, moonScaleDirectDialSSHServerOptions{})
		defer server.Close()
		client := New(ConnectionOptions{Host: "100.64.0.10", Port: 22, User: "alice", Password: "correct-password", HostKeyFingerprint: "SHA256:not-the-server"})
		client.SetTransport(dialMoonScaleTCP(t, server.Addr()))
		defer client.Disconnect()

		if _, err := client.Connect(); err == nil || !strings.Contains(err.Error(), "host key verification failed") {
			t.Fatalf("Connect() error = %v, want host-key verification failure", err)
		}
		server.AssertNoShell(t)
	})

	t.Run("rejects invalid password without exposing it", func(t *testing.T) {
		server := newMoonScaleDirectDialSSHServer(t, moonScaleDirectDialSSHServerOptions{})
		defer server.Close()
		client := New(ConnectionOptions{Host: "100.64.0.10", Port: 22, User: "alice", Password: "wrong-password", HostKeyFingerprint: server.HostKeyFingerprint()})
		client.SetTransport(dialMoonScaleTCP(t, server.Addr()))
		defer client.Disconnect()

		if _, err := client.Connect(); err == nil || strings.Contains(err.Error(), "wrong-password") {
			t.Fatalf("Connect() error = %v, want authentication failure without password", err)
		}
		server.WaitForAuthentication(t, "wrong-password")
		server.AssertNoShell(t)
	})

	t.Run("surfaces a remote close before a session opens", func(t *testing.T) {
		server := newMoonScaleDirectDialSSHServer(t, moonScaleDirectDialSSHServerOptions{closeAfterAuthentication: true})
		defer server.Close()
		client := New(ConnectionOptions{Host: "100.64.0.10", Port: 22, User: "alice", Password: "correct-password", HostKeyFingerprint: server.HostKeyFingerprint()})
		client.SetTransport(dialMoonScaleTCP(t, server.Addr()))
		defer client.Disconnect()

		if _, err := client.Connect(); err == nil || strings.Contains(err.Error(), "correct-password") {
			t.Fatalf("Connect() error = %v, want remote-close error without password", err)
		}
		server.WaitForAuthentication(t, "correct-password")
		server.AssertNoShell(t)
	})
}

type moonScaleDirectDialSSHServer struct {
	listener net.Listener
	signer   ssh.Signer
	options  moonScaleDirectDialSSHServerOptions
	auth     chan string
	pty      chan ptyRequest
	input    chan string
	resize   chan terminalSize
	shell    chan struct{}
	closed   chan struct{}
}

type moonScaleDirectDialSSHServerOptions struct{ closeAfterAuthentication bool }

type terminalSize struct{ cols, rows int }

type ptyRequest struct {
	term string
	cols int
	rows int
}

func newMoonScaleDirectDialSSHServer(t *testing.T, options moonScaleDirectDialSSHServerOptions) *moonScaleDirectDialSSHServer {
	t.Helper()
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &moonScaleDirectDialSSHServer{
		listener: listener,
		signer:   signer,
		options:  options,
		auth:     make(chan string, 1),
		pty:      make(chan ptyRequest, 1),
		input:    make(chan string, 1),
		resize:   make(chan terminalSize, 1),
		shell:    make(chan struct{}, 1),
		closed:   make(chan struct{}, 1),
	}
	go server.serve()
	return server
}

func (s *moonScaleDirectDialSSHServer) Addr() string { return s.listener.Addr().String() }

func (s *moonScaleDirectDialSSHServer) Close() { _ = s.listener.Close() }

func (s *moonScaleDirectDialSSHServer) HostKeyFingerprint() string {
	return ssh.FingerprintSHA256(s.signer.PublicKey())
}

func (s *moonScaleDirectDialSSHServer) WaitForInput(t *testing.T, want string) {
	t.Helper()
	select {
	case got := <-s.input:
		if got != want {
			t.Fatalf("shell input = %q, want %q", got, want)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for shell input %q", want)
	}
}

func (s *moonScaleDirectDialSSHServer) WaitForAuthentication(t *testing.T, want string) {
	t.Helper()
	select {
	case got := <-s.auth:
		if got != want {
			t.Fatalf("authentication password = %q, want %q", got, want)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for authentication")
	}
}

func (s *moonScaleDirectDialSSHServer) WaitForPTY(t *testing.T, term string, cols, rows int) {
	t.Helper()
	select {
	case got := <-s.pty:
		want := ptyRequest{term, cols, rows}
		if got != want {
			t.Fatalf("PTY = %+v, want %+v", got, want)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for PTY request")
	}
}

func (s *moonScaleDirectDialSSHServer) WaitForResize(t *testing.T, cols, rows int) {
	t.Helper()
	select {
	case got := <-s.resize:
		if got != (terminalSize{cols, rows}) {
			t.Fatalf("terminal size = %+v, want %+v", got, terminalSize{cols, rows})
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for resize")
	}
}

func (s *moonScaleDirectDialSSHServer) WaitForClientClose(t *testing.T) {
	t.Helper()
	select {
	case <-s.closed:
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for client close")
	}
}

func (s *moonScaleDirectDialSSHServer) AssertNoShell(t *testing.T) {
	t.Helper()
	select {
	case <-s.shell:
		t.Fatal("server accepted a shell")
	case <-time.After(50 * time.Millisecond):
	}
}

func (s *moonScaleDirectDialSSHServer) serve() {
	conn, err := s.listener.Accept()
	if err != nil {
		return
	}
	config := &ssh.ServerConfig{
		PasswordCallback: func(_ ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			s.auth <- string(password)
			if string(password) != "correct-password" {
				return nil, fmt.Errorf("password rejected")
			}
			return nil, nil
		},
	}
	config.AddHostKey(s.signer)
	_, channels, requests, err := ssh.NewServerConn(conn, config)
	if err != nil {
		return
	}
	if s.options.closeAfterAuthentication {
		_ = conn.Close()
		return
	}
	go ssh.DiscardRequests(requests)
	for newChannel := range channels {
		if newChannel.ChannelType() != "session" {
			_ = newChannel.Reject(ssh.UnknownChannelType, "session required")
			continue
		}
		channel, requests, err := newChannel.Accept()
		if err != nil {
			return
		}
		go s.serveSession(channel, requests)
	}
}

func (s *moonScaleDirectDialSSHServer) serveSession(channel ssh.Channel, requests <-chan *ssh.Request) {
	defer func() { s.closed <- struct{}{} }()
	for request := range requests {
		switch request.Type {
		case "pty-req":
			term, cols, rows := parsePTYRequest(request.Payload)
			s.pty <- ptyRequest{term, int(cols), int(rows)}
			_ = request.Reply(true, nil)
		case "shell":
			_ = request.Reply(true, nil)
			s.shell <- struct{}{}
			_, _ = io.WriteString(channel, "ready\n")
			go func() {
				reader := bufio.NewReader(channel)
				line, err := reader.ReadString('\n')
				if err == nil {
					s.input <- line
					_, _ = io.WriteString(channel, "pong\n")
				}
			}()
		case "window-change":
			cols, rows := parseWindowChange(request.Payload)
			s.resize <- terminalSize{int(cols), int(rows)}
			_ = request.Reply(true, nil)
		default:
			_ = request.Reply(false, nil)
		}
	}
}

func waitForTerminalOutput(t *testing.T, output <-chan string, want string) {
	t.Helper()
	var received string
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	for !strings.Contains(received, want) {
		select {
		case chunk := <-output:
			received += chunk
		case <-timer.C:
			t.Fatalf("terminal output = %q, want %q", received, want)
		}
	}
}

func parsePTYRequest(payload []byte) (string, uint32, uint32) {
	if len(payload) < 4 {
		return "", 0, 0
	}
	termLength := int(uint32(payload[0])<<24 | uint32(payload[1])<<16 | uint32(payload[2])<<8 | uint32(payload[3]))
	if len(payload) < 4+termLength+8 {
		return "", 0, 0
	}
	term := string(payload[4 : 4+termLength])
	cols, rows := parseWindowChange(payload[4+termLength:])
	return term, cols, rows
}

func parseWindowChange(payload []byte) (uint32, uint32) {
	if len(payload) < 8 {
		return 0, 0
	}
	return uint32(payload[0])<<24 | uint32(payload[1])<<16 | uint32(payload[2])<<8 | uint32(payload[3]),
		uint32(payload[4])<<24 | uint32(payload[5])<<16 | uint32(payload[6])<<8 | uint32(payload[7])
}

type moonScaleDirectDialAdapter struct{ target string }

func (a moonScaleDirectDialAdapter) dialTCP() (net.Conn, error) { return net.Dial("tcp", a.target) }

func dialMoonScaleTCP(t *testing.T, target string) net.Conn {
	t.Helper()
	conn, err := (moonScaleDirectDialAdapter{target: target}).dialTCP()
	if err != nil {
		t.Fatal(err)
	}
	return conn
}
