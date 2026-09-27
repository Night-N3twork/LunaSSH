package lunassh

import (
	"errors"
	"strings"
	"testing"
)

func TestJSTransportReportsTargetCloseAfterHostKeyWithoutSecrets(t *testing.T) {
	transport := NewJSTransport("test", nil, nil)
	callback, err := hostKeyCallback(ConnectionOptions{InsecureSkipHostKeyVerification: true})
	if err != nil {
		t.Fatal(err)
	}

	if err := validatedHostKeyCallback(callback, transport)("target.test:22", nil, testPublicKey(t)); err != nil {
		t.Fatal(err)
	}
	transport.FailWispClose(wispCloseReasonStreamUnreachable)

	_, err = transport.Read(make([]byte, 1))
	var closeErr *WispTransportCloseError
	if !errors.As(err, &closeErr) {
		t.Fatalf("Read() error = %v, want WispTransportCloseError", err)
	}
	if closeErr.Reason != wispCloseReasonStreamUnreachable {
		t.Fatalf("reason = %d, want %d", closeErr.Reason, wispCloseReasonStreamUnreachable)
	}
	if closeErr.Stage != sshConnectionStagePostKey {
		t.Fatalf("stage = %q, want %q", closeErr.Stage, sshConnectionStagePostKey)
	}
	if got := err.Error(); got != "wisp transport closed during post-key: STREAM_UNREACHABLE (0x42)" {
		t.Fatalf("error = %q", got)
	}
	if strings.Contains(err.Error(), "password") {
		t.Fatalf("error leaked credentials: %q", err)
	}
}

func TestJSTransportMarksUserAuthAfterPostKeyNewKeysWrite(t *testing.T) {
	transport := NewJSTransport("test", nil, nil)
	transport.setConnectionStage(sshConnectionStagePostKey)

	if _, err := transport.Write([]byte("newkeys")); err != nil {
		t.Fatal(err)
	}
	if transport.stage != sshConnectionStagePostKey {
		t.Fatalf("stage after NEWKEYS = %q, want %q", transport.stage, sshConnectionStagePostKey)
	}
	if _, err := transport.Write([]byte("userauth service")); err != nil {
		t.Fatal(err)
	}
	if transport.stage != sshConnectionStageUserAuth {
		t.Fatalf("stage after userauth starts = %q, want %q", transport.stage, sshConnectionStageUserAuth)
	}
}

func TestJSTransportReportsRemoteStreamCloseDuringUserAuth(t *testing.T) {
	transport := NewJSTransport("test", nil, nil)
	transport.setConnectionStage(sshConnectionStageUserAuth)
	transport.FailWispClose(0x02)

	_, err := transport.Read(make([]byte, 1))
	if got := err.Error(); got != "remote SSH stream closed during user authentication: VOLUNTARY (0x02)" {
		t.Fatalf("error = %q", got)
	}
}
