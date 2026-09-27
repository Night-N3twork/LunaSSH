//go:build js && wasm

package main

import (
	"fmt"
	"sync"
	"syscall/js"

	"github.com/Night-N3twork/LunaSSH/pkg/lunassh"
)

func main() {
	fmt.Println("LunaSSH WASM initialized")

	js.Global().Set("SSHClient", js.ValueOf(map[string]interface{}{
		"connect":             js.FuncOf(connect),
		"disconnect":          js.FuncOf(disconnect),
		"send":                js.FuncOf(send),
		"version":             js.FuncOf(version),
		"createTransport":     js.FuncOf(createTransport),
		"closeTransport":      js.FuncOf(closeTransport),
		"failTransport":       js.FuncOf(failTransport),
		"injectTransportData": js.FuncOf(injectTransportData),
	}))

	select {}
}

// failTransport propagates a redacted Wisp CLOSE reason into the Go transport.
func failTransport(this js.Value, args []js.Value) interface{} {
	if len(args) < 2 {
		return promiseReject("missing transport ID or Wisp close reason")
	}
	transport, ok := lunassh.GetTransport(args[0].String())
	if !ok {
		return promiseReject("transport not found")
	}
	transport.FailWispClose(uint8(args[1].Int()))
	lunassh.RemoveTransport(args[0].String())
	return promiseResolve(nil)
}

func connect(this js.Value, args []js.Value) interface{} {
	if len(args) < 2 {
		return promiseReject("missing connection options or transport ID")
	}

	// Create a Promise and immediately start the async work
	promiseConstructor := js.Global().Get("Promise")

	// Create channels to pass resolve/reject functions to goroutine
	type promiseHandlers struct {
		resolve js.Value
		reject  js.Value
	}
	handlersChan := make(chan promiseHandlers, 1)

	// Start the goroutine that will do the actual work
	go func() {
		// Wait for the promise handlers
		handlers := <-handlersChan
		resolve := handlers.resolve
		reject := handlers.reject

		options := parseConnectionOptions(args[0])
		transportID := args[1].String()

		// Get the transport
		transport, ok := lunassh.GetTransport(transportID)
		if !ok {
			reject.Invoke(js.ValueOf("transport not found"))
			return
		}

		client := lunassh.New(options)
		client.SetTransport(transport)

		if len(args) > 2 && args[2].Type() == js.TypeObject {
			callbacks := args[2]

			if onPacketReceive := callbacks.Get("onPacketReceive"); onPacketReceive.Type() == js.TypeFunction {
				client.OnPacketReceive(func(data []byte, metadata map[string]interface{}) {
					// Convert byte slice to Uint8Array for JavaScript
					arrayConstructor := js.Global().Get("Uint8Array")
					dst := arrayConstructor.New(len(data))
					js.CopyBytesToJS(dst, data)
					onPacketReceive.Invoke(dst, js.ValueOf(metadata))
				})
			}

			if onPacketSend := callbacks.Get("onPacketSend"); onPacketSend.Type() == js.TypeFunction {
				client.OnPacketSend(func(data []byte, metadata map[string]interface{}) {
					// Convert byte slice to Uint8Array for JavaScript
					arrayConstructor := js.Global().Get("Uint8Array")
					dst := arrayConstructor.New(len(data))
					js.CopyBytesToJS(dst, data)
					onPacketSend.Invoke(dst, js.ValueOf(metadata))
				})
			}

			if onStateChange := callbacks.Get("onStateChange"); onStateChange.Type() == js.TypeFunction {
				client.OnStateChange(func(state string) {
					onStateChange.Invoke(js.ValueOf(state))
				})
			}

			if onAuthBanner := callbacks.Get("onAuthBanner"); onAuthBanner.Type() == js.TypeFunction {
				client.OnAuthBanner(func(message string) {
					onAuthBanner.Invoke(js.ValueOf(message))
				})
			}

			if onTerminalOutput := callbacks.Get("onTerminalOutput"); onTerminalOutput.Type() == js.TypeFunction {
				client.OnTerminalOutput(func(data []byte) {
					arrayConstructor := js.Global().Get("Uint8Array")
					dst := arrayConstructor.New(len(data))
					js.CopyBytesToJS(dst, data)
					onTerminalOutput.Invoke(dst)
				})
			}
		}

		sessionID, err := client.Connect()
		if err != nil {
			reject.Invoke(js.ValueOf(err.Error()))
			return
		}

		var sendFunc, disconnectFunc, resizeFunc js.Func
		var releaseSessionFuncs sync.Once
		release := func() {
			releaseSessionFuncs.Do(func() {
				sendFunc.Release()
				disconnectFunc.Release()
				resizeFunc.Release()
			})
		}
		sendFunc = js.FuncOf(func(this js.Value, sendArgs []js.Value) interface{} {
			// Create a Promise for async send operation
			promiseConstructor := js.Global().Get("Promise")

			var sendHandler js.Func
			sendHandler = js.FuncOf(func(this js.Value, promiseArgs []js.Value) interface{} {
				defer sendHandler.Release()
				resolve := promiseArgs[0]
				reject := promiseArgs[1]
				go func() {
					if len(sendArgs) == 0 {
						reject.Invoke(js.ValueOf("no data provided"))
						return
					}
					data := make([]byte, sendArgs[0].Length())
					js.CopyBytesToGo(data, sendArgs[0])
					if err := client.Send(data); err != nil {
						reject.Invoke(js.ValueOf(err.Error()))
						return
					}
					resolve.Invoke(js.Null())
				}()
				return nil
			})
			return promiseConstructor.New(sendHandler)
		})
		disconnectFunc = js.FuncOf(func(this js.Value, _ []js.Value) interface{} {
			promiseConstructor := js.Global().Get("Promise")
			var disconnectHandler js.Func
			disconnectHandler = js.FuncOf(func(this js.Value, promiseArgs []js.Value) interface{} {
				defer disconnectHandler.Release()
				resolve, reject := promiseArgs[0], promiseArgs[1]
				go func() {
					if err := client.Disconnect(); err != nil {
						reject.Invoke(js.ValueOf(err.Error()))
						return
					}
					resolve.Invoke(js.Null())
					release()
				}()
				return nil
			})
			return promiseConstructor.New(disconnectHandler)
		})
		resizeFunc = js.FuncOf(func(this js.Value, resizeArgs []js.Value) interface{} {
			promiseConstructor := js.Global().Get("Promise")
			var resizeHandler js.Func
			resizeHandler = js.FuncOf(func(this js.Value, promiseArgs []js.Value) interface{} {
				defer resizeHandler.Release()
				resolve, reject := promiseArgs[0], promiseArgs[1]
				go func() {
					if len(resizeArgs) < 2 {
						reject.Invoke(js.ValueOf("missing cols or rows parameters"))
						return
					}
					if err := client.ResizeTerminal(resizeArgs[0].Int(), resizeArgs[1].Int()); err != nil {
						reject.Invoke(js.ValueOf(err.Error()))
						return
					}
					resolve.Invoke(js.Null())
				}()
				return nil
			})
			return promiseConstructor.New(resizeHandler)
		})

		result := map[string]interface{}{
			"sessionId":      sessionID,
			"send":           sendFunc,
			"disconnect":     disconnectFunc,
			"resizeTerminal": resizeFunc,
		}
		resolve.Invoke(js.ValueOf(result))
	}()

	// Create the Promise with executor that passes handlers to goroutine
	var handler js.Func
	handler = js.FuncOf(func(this js.Value, promiseArgs []js.Value) interface{} {
		defer handler.Release()

		resolve := promiseArgs[0]
		reject := promiseArgs[1]

		// Send the handlers to the goroutine
		handlersChan <- promiseHandlers{resolve: resolve, reject: reject}

		return nil
	})

	return promiseConstructor.New(handler)
}

func disconnect(this js.Value, args []js.Value) interface{} {
	if len(args) < 1 {
		return promiseReject("missing session ID")
	}

	sessionID := args[0].String()
	err := lunassh.DisconnectSession(sessionID)
	if err != nil {
		return promiseReject(err.Error())
	}

	return promiseResolve(nil)
}

func send(this js.Value, args []js.Value) interface{} {
	if len(args) < 2 {
		return promiseReject("missing session ID or data")
	}

	sessionID := args[0].String()
	data := make([]byte, args[1].Length())
	js.CopyBytesToGo(data, args[1])

	err := lunassh.SendToSession(sessionID, data)
	if err != nil {
		return promiseReject(err.Error())
	}

	return promiseResolve(nil)
}

func version(this js.Value, args []js.Value) interface{} {
	return js.ValueOf("1.0.0")
}

func parseConnectionOptions(jsObj js.Value) lunassh.ConnectionOptions {
	options := lunassh.ConnectionOptions{}

	if host := jsObj.Get("host"); host.Type() != js.TypeUndefined {
		options.Host = host.String()
	}

	if port := jsObj.Get("port"); port.Type() != js.TypeUndefined {
		options.Port = port.Int()
	}

	if user := jsObj.Get("user"); user.Type() != js.TypeUndefined {
		options.User = user.String()
	}

	if password := jsObj.Get("password"); password.Type() != js.TypeUndefined {
		options.Password = password.String()
	}

	if privateKey := jsObj.Get("privateKey"); privateKey.Type() != js.TypeUndefined {
		options.PrivateKey = privateKey.String()
	}

	if timeout := jsObj.Get("timeout"); timeout.Type() != js.TypeUndefined {
		options.Timeout = timeout.Int()
	}

	if knownHosts := jsObj.Get("knownHosts"); knownHosts.Type() == js.TypeObject {
		options.KnownHosts = make([]string, knownHosts.Length())
		for index := range options.KnownHosts {
			options.KnownHosts[index] = knownHosts.Index(index).String()
		}
	}

	if hostKeyFingerprint := jsObj.Get("hostKeyFingerprint"); hostKeyFingerprint.Type() != js.TypeUndefined {
		options.HostKeyFingerprint = hostKeyFingerprint.String()
	}

	if hostKey := jsObj.Get("hostKey"); hostKey.Type() != js.TypeUndefined {
		options.HostKey = hostKey.String()
	}

	if insecure := jsObj.Get("insecureSkipHostKeyVerification"); insecure.Type() == js.TypeBoolean {
		options.InsecureSkipHostKeyVerification = insecure.Bool()
	}

	if trustOnFirstUse := jsObj.Get("trustOnFirstUse"); trustOnFirstUse.Type() == js.TypeBoolean {
		options.TrustOnFirstUse = trustOnFirstUse.Bool()
	}

	return options
}

func promiseResolve(value interface{}) js.Value {
	promiseConstructor := js.Global().Get("Promise")
	return promiseConstructor.Call("resolve", js.ValueOf(value))
}

func promiseReject(reason string) js.Value {
	promiseConstructor := js.Global().Get("Promise")
	return promiseConstructor.Call("reject", js.ValueOf(reason))
}

// createTransport creates a new transport bridge to JavaScript
func createTransport(this js.Value, args []js.Value) interface{} {
	if len(args) < 1 {
		return promiseReject("missing transport ID")
	}

	transportID := args[0].String()

	var onWrite js.Value
	var onClose js.Value

	if len(args) > 1 && args[1].Type() == js.TypeObject {
		callbacks := args[1]
		onWrite = callbacks.Get("onWrite")
		onClose = callbacks.Get("onClose")
	}

	// Create write callback
	writeFunc := func(data []byte) error {
		if onWrite.Type() == js.TypeFunction {
			// Convert byte array to Uint8Array for JavaScript
			arrayConstructor := js.Global().Get("Uint8Array")
			dst := arrayConstructor.New(len(data))
			js.CopyBytesToJS(dst, data)
			onWrite.Invoke(dst)
		}
		return nil
	}

	// Create close callback
	closeFunc := func() error {
		if onClose.Type() == js.TypeFunction {
			onClose.Invoke()
		}
		return nil
	}

	transport := lunassh.NewJSTransport(transportID, writeFunc, closeFunc)
	lunassh.RegisterTransport(transportID, transport)

	return js.ValueOf(map[string]interface{}{
		"id":     transportID,
		"status": "created",
	})
}

// closeTransport closes a transport
func closeTransport(this js.Value, args []js.Value) interface{} {
	if len(args) < 1 {
		return promiseReject("missing transport ID")
	}

	transportID := args[0].String()
	transport, ok := lunassh.GetTransport(transportID)
	if !ok {
		return promiseReject("transport not found")
	}

	err := transport.Close()
	lunassh.RemoveTransport(transportID)

	if err != nil {
		return promiseReject(err.Error())
	}

	return promiseResolve(nil)
}

// injectTransportData injects data into a transport from JavaScript
func injectTransportData(this js.Value, args []js.Value) interface{} {
	if len(args) < 2 {
		return promiseReject("missing transport ID or data")
	}

	transportID := args[0].String()
	transport, ok := lunassh.GetTransport(transportID)
	if !ok {
		return promiseReject("transport not found")
	}

	// Convert JavaScript Uint8Array to Go []byte
	data := make([]byte, args[1].Length())
	js.CopyBytesToGo(data, args[1])

	err := transport.InjectData(data)
	if err != nil {
		return promiseReject(err.Error())
	}

	return promiseResolve(nil)
}
