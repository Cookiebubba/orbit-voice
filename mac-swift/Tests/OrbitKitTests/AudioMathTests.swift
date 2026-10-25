// Audio math: test/playback.test.js ported, plus PCM16/base64, levels, the chimes and the resampler.
import XCTest
@testable import OrbitKit

final class AudioMathTests: XCTestCase {
  // MARK: test/playback.test.js

  func testVolumeToGainSquaredWithASaneDefault() {
    XCTAssertEqual(VoiceAudio.volumeGain(1), 1)
    XCTAssertEqual(VoiceAudio.volumeGain(0), 0)
    XCTAssertEqual(VoiceAudio.volumeGain(0.5), 0.25)
    XCTAssertEqual(VoiceAudio.volumeGain(2), 1)
    XCTAssertEqual(VoiceAudio.volumeGain(-1), 0)
    XCTAssertEqual(VoiceAudio.volumeGain(.nan), VoiceAudio.volumeGain(VoiceAudio.defaultVolume))
    XCTAssertEqual(VoiceAudio.volumeGain(nil), VoiceAudio.volumeGain(VoiceAudio.defaultVolume))
    XCTAssert(VoiceAudio.defaultVolume >= 0.7 && VoiceAudio.defaultVolume <= 0.8)
    // The default is quieter than full gain by about 5 dB.
    XCTAssertLessThan(abs(20 * log10(VoiceAudio.volumeGain(VoiceAudio.defaultVolume)) + 5), 0.1)
  }

  func testChimesStayAsLoudAsBeforeAtTheDefaultAndFollowTheVoice() {
    XCTAssertEqual(VoiceAudio.chimeLevel(VoiceAudio.defaultVolume), 0.12, accuracy: 1e-12)
    XCTAssertLessThan(VoiceAudio.chimeLevel(0.3), 0.12)
    XCTAssertEqual(VoiceAudio.chimeLevel(0), 0)
    XCTAssertLessThanOrEqual(VoiceAudio.chimeLevel(1), 0.2)
  }

  func testAReleaseFollowsAudioThatStopsAbruptly() {
    let pcm = (0..<2400).map { i in Int16((sin(2 * Double.pi * 880 * Double(i) / 24000) * 16000).rounded()) }
    let tail = VoiceAudio.releaseTail(pcm)!
    XCTAssertEqual(tail.count, Int((24000 * VoiceAudio.releaseMs / 1000).rounded()))
    XCTAssert(VoiceAudio.releaseMs >= 80 && VoiceAudio.releaseMs <= 150)
    let last = Float(pcm.last!) / 0x8000
    XCTAssertLessThan(abs(tail[0] - last), 0.01, "it carries on from the very last sample (no jump)")
    func rms(_ a: Int, _ b: Int) -> Double { VoiceAudio.rms(Array(tail[a..<b])) }
    XCTAssert(rms(0, 240) > rms(1200, 1440) && rms(1200, 1440) > rms(2400, 2640), "it falls away")
    XCTAssertLessThan(abs(tail.last!), 0.5 / 200, "to about -48 dB")
  }

  func testNoReleaseForAudioThatAlreadyEndsInQuiet() {
    let pcm = (0..<2400).map { i in i < 1800 ? Int16((sin(Double(i) / 3) * 16000).rounded()) : 0 }
    XCTAssertNil(VoiceAudio.releaseTail(pcm))
    XCTAssertNil(VoiceAudio.releaseTail([Int16]()))
    // A very short chunk still makes a full-length release.
    XCTAssertEqual(VoiceAudio.releaseTail([Int16](repeating: 12000, count: 50))?.count, 2880)
  }

  func testTalkingOverOnlyTheLastMomentsOfAFinishedReplyLetsItFinish() {
    XCTAssertTrue(VoiceAudio.letItFinish(remainingS: 0.25, replyDone: true))
    XCTAssertTrue(VoiceAudio.letItFinish(remainingS: VoiceAudio.finishWithinS, replyDone: true))
    XCTAssertFalse(VoiceAudio.letItFinish(remainingS: 1.5, replyDone: true), "a real interruption")
    XCTAssertFalse(VoiceAudio.letItFinish(remainingS: 0.25, replyDone: false), "more of the reply is still coming")
    XCTAssertFalse(VoiceAudio.letItFinish(remainingS: 0, replyDone: true), "nothing playing")
  }

  // MARK: PCM16, base64, levels

  func testPCM16Base64RoundTripsLittleEndian() {
    let pcm: [Int16] = [0, 1, -1, 32767, -32768, 0x1234]
    let b64 = VoiceAudio.base64(pcm)
    XCTAssertEqual(Array(Data(base64Encoded: b64)!), [0, 0, 1, 0, 0xff, 0xff, 0xff, 0x7f, 0x00, 0x80, 0x34, 0x12])
    XCTAssertEqual(VoiceAudio.pcm16(base64: b64), pcm)
    XCTAssertEqual(VoiceAudio.pcm16(base64: "AAEC"), [256], "an odd last byte is dropped")
    XCTAssertEqual(VoiceAudio.pcm16(base64: "%%%"), [])
  }

  func testFloatToPCM16AsTheCaptureWorkletDoes() {
    XCTAssertEqual(VoiceAudio.pcm16(float: [0, 1, -1, 2, -2, 0.5, -0.5, .nan]), [0, 32767, -32768, 32767, -32768, 16383, -16384, 0])
    XCTAssertEqual(VoiceAudio.float(pcm16: [-32768, 16384]), [-1, 0.5])
  }

  func testLevelsAsThePageComputesThem() {
    XCTAssertEqual(VoiceAudio.rms([Int16](repeating: 16384, count: 100)), 0.5, accuracy: 1e-9)
    XCTAssertEqual(VoiceAudio.rms([Int16]()), 0)
    XCTAssertEqual(VoiceAudio.peak([3, -900, 20]), 900)
    var m = LevelMeter()
    var l = m.tick(input: 0.1, output: 0.1)
    XCTAssertEqual(l.input, 0.6, accuracy: 1e-9)
    XCTAssertEqual(l.output, 0.5, accuracy: 1e-9)
    l = m.tick(input: 0, output: 0)
    XCTAssertEqual(l.input, 0.48, accuracy: 1e-9, "falls away by 0.8 a tick")
    l = m.tick(input: 1, output: 1)
    XCTAssertEqual(l.input, 1)
    XCTAssertEqual(l.output, 1)
  }

  func testChunkerMakes2400SampleFrames() {
    var c = PCMChunker()
    XCTAssertEqual(c.push([Int16](repeating: 1, count: 1000)).count, 0)
    let out = c.push([Int16](repeating: 2, count: 4000))
    XCTAssertEqual(out.count, 2)
    XCTAssertEqual(out[0].count, 2400)
    XCTAssertEqual(out[0][999], 1)
    XCTAssertEqual(out[0][1000], 2)
    XCTAssertEqual(c.push([Int16](repeating: 3, count: 2199)).count, 0, "200 left over + 2199: one short")
    XCTAssertEqual(c.push([3]).first?.first, 2, "the leftover comes first")
  }

  func testDownmixAverages() {
    XCTAssertEqual(VoiceAudio.downmix([[1, 0.5], [0, -0.5]]), [0.5, 0])
    XCTAssertEqual(VoiceAudio.downmix([[0.25]]), [0.25])
  }

  // MARK: chimes (ui/src/sounds.ts)

  func testChimesHaveThePagesNotesAndEnvelope() {
    XCTAssertEqual(Chime.wake.notes, [523.25, 783.99])
    XCTAssertEqual(Chime.sleep.notes, [783.99, 523.25])
    XCTAssertEqual(Chime.done.notes, [659.25, 783.99, 1046.5])
    XCTAssertEqual(Chime.done.duration, 0.56, accuracy: 1e-9)
    let r = 48000.0
    let s = Chime.wake.render(volume: 0.12, rate: r)
    XCTAssertEqual(s.count, Int((0.44 * r).rounded(.up)))
    XCTAssertEqual(s[0], 0, "starts silent")
    let peak = s.prefix(Int(0.1 * r)).map { abs($0) }.max()!
    XCTAssert(peak > 0.1 && peak <= 0.12 + 1e-6, "rises to the volume in 20 ms (\(peak))")
    let late = s[Int(0.11 * r)..<Int(0.119 * r)].map { abs($0) }.max()!
    XCTAssertLessThan(late, peak / 3, "falls away before the next note")
    XCTAssertEqual(Chime.sleep.render(volume: 0).allSatisfy { $0 == 0 }, true)
  }
}

final class ResamplerTests: XCTestCase {
  func tone(_ f: Double, rate: Double, seconds: Double, amp: Double = 0.5) -> [Float] {
    (0..<Int(rate * seconds)).map { Float(amp * sin(2 * Double.pi * f * Double($0) / rate)) }
  }

  /** Amplitude of frequency `f` in `x` (a single-bin DFT over whole cycles). */
  func amplitude(_ x: [Float], _ f: Double, rate: Double) -> Double {
    var re = 0.0, im = 0.0
    for (i, s) in x.enumerated() { let a = 2 * Double.pi * f * Double(i) / rate; re += Double(s) * cos(a); im += Double(s) * sin(a) }
    return 2 * (re * re + im * im).squareRoot() / Double(x.count)
  }

  func testDownsampling48kTo24kKeepsSpeechAndRemovesWhatWouldAlias() {
    let r = Resampler(from: 48000, to: 24000)
    let out = r.process(tone(1000, rate: 48000, seconds: 1))
    XCTAssertEqual(Double(out.count), 24000, accuracy: 40)
    let body = Array(out[2400..<21600])
    XCTAssertEqual(amplitude(body, 1000, rate: 24000), 0.5, accuracy: 0.01, "1 kHz passes at full level")
    // 15 kHz can't exist at 24 kHz: dropping samples would fold it to 9 kHz at full level.
    let hi = Resampler(from: 48000, to: 24000).process(tone(15000, rate: 48000, seconds: 1))
    let folded = amplitude(Array(hi[2400..<21600]), 9000, rate: 24000)
    XCTAssertLessThan(folded, 0.5 * 0.01, "15 kHz is filtered out (> 40 dB), not folded to 9 kHz")
  }

  func testFromCDRateAndUpFromTelephoneRate() {
    let a = Resampler(from: 44100, to: 24000).process(tone(440, rate: 44100, seconds: 1))
    XCTAssertEqual(Double(a.count), 24000, accuracy: 40)
    XCTAssertEqual(amplitude(Array(a[2400..<21600]), 440, rate: 24000), 0.5, accuracy: 0.01)
    let b = Resampler(from: 16000, to: 24000).process(tone(300, rate: 16000, seconds: 1))
    XCTAssertEqual(Double(b.count), 24000, accuracy: 40)
    XCTAssertEqual(amplitude(Array(b[2400..<21600]), 300, rate: 24000), 0.5, accuracy: 0.01)
  }

  func testChunkBoundariesDontMatter() {
    let input = tone(700, rate: 48000, seconds: 0.5)
    let whole = Resampler(from: 48000, to: 24000).process(input)
    let r = Resampler(from: 48000, to: 24000)
    var pieces: [Float] = []
    var i = 0
    var n = 1
    while i < input.count {
      let j = min(input.count, i + n)
      pieces += r.process(Array(input[i..<j]))
      i = j
      n = n * 7 % 1013 + 1
    }
    XCTAssertEqual(pieces.count, whole.count)
    for k in 0..<whole.count { XCTAssertEqual(pieces[k], whole[k], accuracy: 1e-6) }
  }

  func testSameRateIsPassthrough() {
    let r = Resampler(from: 24000, to: 24000)
    XCTAssertEqual(r.process([0.1, 0.2]), [0.1, 0.2])
  }
}
