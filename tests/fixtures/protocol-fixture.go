// Generate from the SDK module directory with:
// go run ../../agent-collaboration-web/tests/fixtures/protocol-fixture.go
// This fixture uses the public test seed 00..1f, never a real agent identity.
package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"os"

	agentcrypto "github.com/BillShiyaoZhang/agent-comm/crypto"
	pb "github.com/BillShiyaoZhang/agent-comm/proto"
	"github.com/BillShiyaoZhang/agent-comm/registry"
	"google.golang.org/protobuf/proto"
)

func mustMarshal(message proto.Message) []byte {
	result, err := (proto.MarshalOptions{Deterministic: true}).Marshal(message)
	if err != nil {
		panic(err)
	}
	return result
}

func main() {
	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = byte(i)
	}
	private := ed25519.NewKeyFromSeed(seed)
	identity := &agentcrypto.IdentityKeyPair{PrivateKey: private, PublicKey: private.Public().(ed25519.PublicKey), URNPrefix: "urn:hermes:agent"}
	recipient := "urn:agent-comm:agent:recipient-fixture"
	env := &pb.EncryptedEnvelope{
		SenderStaticPubkey: bytes.Repeat([]byte{0x11}, 32),
		EphemeralPubkey:    bytes.Repeat([]byte{0x22}, 32),
		Nonce:              bytes.Repeat([]byte{0x33}, 12),
		Ciphertext:         []byte("fixture ciphertext"),
		Tag:                bytes.Repeat([]byte{0x44}, 16),
		MessageId:          "message-go-fixture", RecipientUrn: recipient,
	}
	if err := agentcrypto.SignEnvelope(env, identity); err != nil {
		panic(err)
	}
	unsigned := proto.Clone(env).(*pb.EncryptedEnvelope)
	unsigned.Signature = nil
	signingBytes := append([]byte(agentcrypto.EnvelopeSignatureDomain), mustMarshal(unsigned)...)
	extended := proto.Clone(env).(*pb.EncryptedEnvelope)
	extended.Ciphertext = nil // proto3 default must be omitted when signing.
	extended.ProtoReflect().SetUnknown([]byte{0x98, 0x06, 0x01, 0xa5, 0x06, 1, 2, 3, 4})
	if err := agentcrypto.SignEnvelope(extended, identity); err != nil {
		panic(err)
	}
	peerID, err := identity.PeerID()
	if err != nil {
		panic(err)
	}
	timestamp := int64(1700000123)
	registrationBytes := registry.BuildSignedMsg(identity.URN(), peerID, env.SenderStaticPubkey, true, timestamp)
	registrationSignature := ed25519.Sign(private, registrationBytes)
	if err := registry.VerifyRegistration(identity.URN(), peerID, env.SenderStaticPubkey, identity.PublicKey, registrationSignature, true, timestamp); err != nil {
		panic(err)
	}
	chatText := `{"agent_comm":1,"text":"你好 Hermes","conversation_id":"conversation-fixture","in_reply_to":"previous-message","task_id":"task-fixture","kind":"result","deadline":"2030-01-02T03:04:05Z","hop_limit":3}`
	chat := &pb.ChatMessage{Body: &pb.ChatMessage_Text{Text: &pb.TextMessage{Text: chatText, Timestamp: timestamp}}}
	negative := &pb.ChatMessage{Body: &pb.ChatMessage_Text{Text: &pb.TextMessage{Timestamp: -1}}}
	fixture := map[string]any{
		"source": "agent-comm Go deterministic protobuf + crypto.SignEnvelope + registry.VerifyRegistration; test seed 00..1f",
		"seed":   seed, "senderUrn": identity.URN(), "recipientUrn": recipient,
		"publicKey": identity.PublicKey, "peerId": peerID,
		"envelope": mustMarshal(env), "signingBytes": signingBytes,
		"extendedEnvelope":      mustMarshal(extended),
		"registrationTimestamp": timestamp, "registrationSigningBytes": registrationBytes,
		"registrationSignature": registrationSignature,
		"chat":                  mustMarshal(chat), "negativeTimestampChat": mustMarshal(negative),
		"emptyChat": mustMarshal(&pb.ChatMessage{Body: &pb.ChatMessage_Text{Text: &pb.TextMessage{}}}),
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(fixture); err != nil {
		panic(err)
	}
}
