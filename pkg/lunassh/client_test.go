package lunassh

import (
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func TestConnectionTimeoutDefaultsToFiniteDuration(t *testing.T) {
	if got := connectionTimeout(0); got != 30*time.Second {
		t.Fatalf("default timeout = %v, want 30s", got)
	}
	if got := connectionTimeout(7); got != 7*time.Second {
		t.Fatalf("configured timeout = %v, want 7s", got)
	}
}

func TestTerminalOutputDoesNotUsePacketCallbacks(t *testing.T) {
	client := New(ConnectionOptions{})
	packetCalls := 0
	var output []byte

	client.OnPacketReceive(func([]byte, map[string]interface{}) {
		packetCalls++
	})
	client.OnTerminalOutput(func(data []byte) {
		output = append(output, data...)
	})

	client.emitTerminalOutput([]byte("prompt$ "))

	if got := string(output); got != "prompt$ " {
		t.Fatalf("terminal output = %q, want %q", got, "prompt$ ")
	}
	if packetCalls != 0 {
		t.Fatalf("packet callback called %d times for terminal output", packetCalls)
	}
}

func TestConnectStartsInteractiveSessionBeforeReturning(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	serverConfig := &ssh.ServerConfig{NoClientAuth: true}
	serverConfig.AddHostKey(signer)
	windowChange := make(chan struct{}, 1)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			serveInteractiveSession(conn, serverConfig, windowChange)
		}
	}()
	clientConn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}

	client := New(ConnectionOptions{Host: "server.test", Port: 22, User: "alice", InsecureSkipHostKeyVerification: true})
	client.SetTransport(clientConn)
	defer client.Disconnect()

	if _, err := client.Connect(); err != nil {
		t.Fatalf("Connect() error = %v", err)
	}
	if err := client.ResizeTerminal(120, 40); err != nil {
		t.Fatalf("ResizeTerminal() immediately after Connect() error = %v", err)
	}
	select {
	case <-windowChange:
	case <-time.After(time.Second):
		t.Fatal("remote session did not receive a window-change request")
	}
}

func TestDisconnectImmediatelyAfterConnectStopsShellInput(t *testing.T) {
	for i := 0; i < 20; i++ {
		server := newMoonScaleDirectDialSSHServer(t, moonScaleDirectDialSSHServerOptions{})
		client := New(ConnectionOptions{
			Host:               "server.test",
			Port:               22,
			User:               "alice",
			Password:           "correct-password",
			HostKeyFingerprint: server.HostKeyFingerprint(),
		})
		client.SetTransport(dialMoonScaleTCP(t, server.Addr()))
		if _, err := client.Connect(); err != nil {
			server.Close()
			t.Fatalf("Connect() error = %v", err)
		}
		if err := client.Disconnect(); err != nil {
			server.Close()
			t.Fatalf("Disconnect() error = %v", err)
		}
		server.WaitForClientClose(t)
		server.Close()
		if err := client.Send([]byte("after disconnect")); err == nil {
			t.Fatal("Send() succeeded after disconnect")
		}
	}
}

func TestConnectDeliversAuthBannerBeforeAuthenticationFailurePerClient(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}

	for _, banner := range []string{"Visit https://login.tailscale.com/a/check to approve\r\n", "Second client's banner\r\n"} {
		t.Run(banner, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			config := &ssh.ServerConfig{
				BannerCallback: func(ssh.ConnMetadata) string { return banner },
				PasswordCallback: func(ssh.ConnMetadata, []byte) (*ssh.Permissions, error) {
					return nil, fmt.Errorf("authentication denied")
				},
			}
			config.AddHostKey(signer)
			serverDone := make(chan struct{})
			go func() {
				defer close(serverDone)
				conn, err := listener.Accept()
				if err == nil {
					defer conn.Close()
					ssh.NewServerConn(conn, config)
				}
			}()
			conn, err := net.Dial("tcp", listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			client := New(ConnectionOptions{Host: "server.test", Port: 22, User: "alice", Password: "wrong", InsecureSkipHostKeyVerification: true})
			client.SetTransport(conn)
			var received []string
			client.OnAuthBanner(func(message string) { received = append(received, message) })
			_, err = client.Connect()
			conn.Close()
			<-serverDone
			if err == nil {
				t.Fatal("Connect() succeeded despite rejected authentication")
			}
			if len(received) != 1 || received[0] != banner {
				t.Fatalf("banners before Connect returned = %q, want [%q]", received, banner)
			}
		})
	}
}

func serveInteractiveSession(conn net.Conn, config *ssh.ServerConfig, windowChange chan<- struct{}) {
	_, channels, requests, err := ssh.NewServerConn(conn, config)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(requests)
	for newChannel := range channels {
		if newChannel.ChannelType() != "session" {
			newChannel.Reject(ssh.UnknownChannelType, "interactive session required")
			continue
		}
		channel, requests, err := newChannel.Accept()
		if err != nil {
			return
		}
		for request := range requests {
			switch request.Type {
			case "pty-req", "shell":
				request.Reply(true, nil)
			case "window-change":
				request.Reply(true, nil)
				select {
				case windowChange <- struct{}{}:
				default:
				}
			}
		}
		channel.Close()
	}
}

func TestHostKeyCallbackReportsFingerprintWithoutVerificationConfiguration(t *testing.T) {
	key := testPublicKey(t)
	callback, err := hostKeyCallback(ConnectionOptions{})
	if err != nil {
		t.Fatalf("hostKeyCallback() error = %v", err)
	}
	if callback == nil {
		t.Fatal("hostKeyCallback() returned a nil callback")
	}

	err = callback("example.test:22", &net.TCPAddr{Port: 22}, key)
	want := "unverified host key for example.test:22: " + ssh.FingerprintSHA256(key)
	if err == nil || err.Error() != want {
		t.Fatalf("callback() error = %v, want %q", err, want)
	}
}

func TestConnectDiscoversHostKeyBeforeExplicitConfirmation(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	serverConfig := &ssh.ServerConfig{NoClientAuth: true}
	serverConfig.AddHostKey(signer)
	fingerprint := ssh.FingerprintSHA256(signer.PublicKey())

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	firstHandshake := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			firstHandshake <- err
			return
		}
		_, _, _, err = ssh.NewServerConn(conn, serverConfig)
		firstHandshake <- err
		conn.Close()

		conn, err = listener.Accept()
		if err == nil {
			defer conn.Close()
			serveInteractiveSession(conn, serverConfig, make(chan struct{}, 1))
		}
	}()

	firstConn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	first := New(ConnectionOptions{Host: "server.test", Port: 22, User: "alice"})
	first.SetTransport(firstConn)
	_, err = first.Connect()
	firstConn.Close()
	want := "unverified host key for server.test:22: " + fingerprint
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("first Connect() error = %v, want %q", err, want)
	}
	t.Logf("first Connect() error: %v", err)
	select {
	case err := <-firstHandshake:
		if err == nil {
			t.Fatal("server completed an unverified handshake")
		}
	case <-time.After(time.Second):
		t.Fatal("server did not attempt the first SSH handshake")
	}

	secondConn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer secondConn.Close()
	callback, err := hostKeyCallback(ConnectionOptions{HostKeyFingerprint: fingerprint})
	if err != nil {
		t.Fatalf("confirmed hostKeyCallback() error = %v", err)
	}
	confirmed, _, _, err := ssh.NewClientConn(secondConn, "server.test:22", &ssh.ClientConfig{User: "alice", HostKeyCallback: callback})
	if err != nil {
		t.Fatalf("confirmed SSH handshake error = %v", err)
	}
	defer confirmed.Close()
}

func TestHostKeyCallbackReportsFingerprintForInteractiveTrust(t *testing.T) {

	key := testPublicKey(t)
	callback, err := hostKeyCallback(ConnectionOptions{TrustOnFirstUse: true})
	if err != nil {
		t.Fatalf("hostKeyCallback() error = %v", err)
	}

	err = callback("example.test:22", &net.TCPAddr{Port: 22}, key)
	want := "unverified host key for example.test:22: " + ssh.FingerprintSHA256(key)
	if err == nil || err.Error() != want {
		t.Fatalf("callback() error = %v, want %q", err, want)
	}
}

func TestHostKeyCallbackAcceptsConfiguredPins(t *testing.T) {
	key := testPublicKey(t)
	serialized := string(ssh.MarshalAuthorizedKey(key))
	address := &net.TCPAddr{IP: net.ParseIP("192.0.2.1"), Port: 22}

	tests := []struct {
		name     string
		options  ConnectionOptions
		hostname string
	}{
		{name: "SHA-256 fingerprint", options: ConnectionOptions{HostKeyFingerprint: ssh.FingerprintSHA256(key)}},
		{name: "MD5 fingerprint", options: ConnectionOptions{HostKeyFingerprint: ssh.FingerprintLegacyMD5(key)}},
		{name: "authorized key", options: ConnectionOptions{HostKey: serialized}},
		{name: "known host", options: ConnectionOptions{Host: "example.test", Port: 22, KnownHosts: []string{"example.test " + serialized}}},
		{name: "port-qualified known host", options: ConnectionOptions{Host: "example.test", Port: 2200, KnownHosts: []string{"[example.test]:2200 " + serialized}}, hostname: "example.test:2200"},
		{name: "insecure opt-in", options: ConnectionOptions{InsecureSkipHostKeyVerification: true}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			callback, err := hostKeyCallback(test.options)
			if err != nil {
				t.Fatalf("hostKeyCallback() error = %v", err)
			}
			hostname := test.hostname
			if hostname == "" {
				hostname = "example.test:22"
			}
			if err := callback(hostname, address, key); err != nil {
				t.Fatalf("callback() error = %v", err)
			}
		})
	}
}

func TestHostKeyCallbackRejectsNonMatchingKey(t *testing.T) {
	callback, err := hostKeyCallback(ConnectionOptions{HostKeyFingerprint: "SHA256:not-the-server"})
	if err != nil {
		t.Fatalf("hostKeyCallback() error = %v", err)
	}

	if err := callback("example.test:22", &net.TCPAddr{Port: 22}, testPublicKey(t)); err == nil || err.Error() != "host key verification failed for example.test:22" {
		t.Fatalf("callback() error = %v", err)
	}
}

func testPublicKey(t *testing.T) ssh.PublicKey {
	t.Helper()
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewPublicKey(privateKey.Public())
	if err != nil {
		t.Fatal(err)
	}
	return key
}
