"""macOS end-to-end tests (CI): the JavaScript engine under osascript, and the
zsh plugin in a pseudo-terminal. The "terminal" is a pyte screen that also
models the alternate screen. Test-only dependency: pyte."""

import fcntl
import os
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
import unittest

import pyte

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
PLUGIN = os.path.join(ROOT, 'blackhole-break.plugin.zsh')
SAMPLE = os.path.join(ROOT, 'tests', 'sample-screen.txt')
COLS, ROWS = 90, 28


class AltScreen(pyte.Screen):
    def __init__(self, c, r):
        super().__init__(c, r)
        self.in_alt, self.saved = False, None

    def set_mode(self, *modes, **kw):
        if kw.get('private') and 1049 in modes:
            self.saved = ({y: dict(row) for y, row in self.buffer.items()}, (self.cursor.x, self.cursor.y))
            self.in_alt = True
            self.erase_in_display(2)
            modes = tuple(m for m in modes if m != 1049)
            if not modes:
                return
        super().set_mode(*modes, **kw)

    def reset_mode(self, *modes, **kw):
        if kw.get('private') and 1049 in modes:
            if self.saved:
                buf, (x, y) = self.saved
                self.buffer.clear()
                for yy, row in buf.items():
                    self.buffer[yy].update(row)
                self.cursor.x, self.cursor.y = x, y
            self.in_alt, self.saved = False, None
            modes = tuple(m for m in modes if m != 1049)
            if not modes:
                return
        super().reset_mode(*modes, **kw)

    def text(self):
        return '\n'.join(''.join(self.buffer[y][x].data for x in range(self.columns)).rstrip() for y in range(self.lines))


class Term(object):
    def __init__(self, argv, env):
        self.screen = AltScreen(COLS, ROWS)
        self.stream = pyte.ByteStream(self.screen)
        master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('hhhh', ROWS, COLS, 0, 0))
        pid = os.fork()
        if pid == 0:
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            for fd in (0, 1, 2):
                os.dup2(slave, fd)
            os.close(master)
            os.execvpe(argv[0], argv, env)
        os.close(slave)
        self.pid, self.master = pid, master
        self.alt_seen = False

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.master], [], [], max(0, end - time.time()))
            if not r:
                continue
            try:
                data = os.read(self.master, 65536)
            except OSError:
                return
            if not data:
                return
            self.stream.feed(data)
            self.alt_seen = self.alt_seen or self.screen.in_alt

    def wait_for(self, pred, timeout):
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.05)
            if pred():
                return True
        return False

    def send(self, b):
        os.write(self.master, b)

    def close(self):
        try:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except OSError:
            pass
        os.close(self.master)


class JxaEngineTest(unittest.TestCase):
    def test_every_effect_runs_under_osascript(self):
        d = tempfile.mkdtemp()
        for effect in ('blackHole', 'wormhole', 'supernova', 'dust'):
            out, res = os.path.join(d, effect + '.ans'), os.path.join(d, effect + '.res')
            t0 = time.time()
            subprocess.run(['osascript', '-l', 'JavaScript', os.path.join(ROOT, 'blackhole-break.js'),
                            'screen=' + SAMPLE, 'cols=%d' % COLS, 'rows=%d' % ROWS, 'out=' + out, 'result=' + res,
                            'effect=' + effect, 'rest=0.5', 'speed=4', 'fps=30', 'message=Rest now'],
                           check=True, timeout=60)
            took = time.time() - t0
            with open(res) as f:
                self.assertEqual(f.read(), 'done', effect)
            with open(out, 'rb') as f:
                data = f.read()
            self.assertTrue(data.startswith(b'\x1b[?1049h'), effect)
            self.assertTrue(data.endswith(b'\x1b[?1049l'), effect)
            scr = AltScreen(COLS, ROWS)
            pyte.ByteStream(scr).feed(data)
            self.assertFalse(scr.in_alt)
            self.assertLess(took, 15, effect + ' too slow: %.1fs' % took)
            print('%s: %.1f s, %d bytes' % (effect, took, len(data)))


class ZshPluginTest(unittest.TestCase):
    def start(self, **settings):
        home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, home, True)
        conf = dict(BHB_INTERVAL_MINUTES='0.05', BHB_REST_SECONDS='1', BHB_SPEED='4', BHB_IDLE_SECONDS='0',
                    BHB_TEST_SCREEN=SAMPLE, BHB_STATE_DIR=os.path.join(home, 'state'))
        conf.update(settings)
        with open(os.path.join(home, '.zshrc'), 'w') as f:
            f.write("PS1='$ '\nunsetopt PROMPT_SP\n")
            for k, v in conf.items():
                f.write("%s='%s'\n" % (k, v))
            f.write('source %s\n' % PLUGIN)
        env = {'HOME': home, 'ZDOTDIR': home, 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
               'TERM_PROGRAM': 'Apple_Terminal', 'LANG': 'en_US.UTF-8'}
        t = Term(['/bin/zsh', '-i'], env)
        self.addCleanup(t.close)
        self.assertTrue(t.wait_for(lambda: '$' in t.screen.text(), 10), 'no prompt:\n' + t.screen.text())
        self.home = home
        return t

    def run_cmd(self, t, cmd, until):
        t.send(cmd.encode() + b'\r')
        self.assertTrue(t.wait_for(lambda: until in t.screen.text(), 10), 'no %r:\n%s' % (until, t.screen.text()))

    def test_timer_break_restores_the_screen(self):
        t = self.start()
        self.run_cmd(t, 'echo hello-world', 'hello-world')
        before = t.screen.text()
        self.assertTrue(t.wait_for(lambda: t.screen.in_alt, 15), 'no break from the timer:\n' + t.screen.text())
        t.pump(0.5)
        self.assertNotEqual(t.screen.text(), before)
        self.assertTrue(t.wait_for(lambda: not t.screen.in_alt, 15), 'break did not end')
        t.pump(0.5)
        self.assertEqual(t.screen.text(), before)
        self.run_cmd(t, 'echo still-works', 'still-works')

    def test_key_ends_the_break_and_is_not_typed(self):
        t = self.start(BHB_INTERVAL_MINUTES='600', BHB_REST_SECONDS='30')
        self.run_cmd(t, 'echo ready', 'ready')
        before = t.screen.text()
        t.send(b'bhb-now\r')
        self.assertTrue(t.wait_for(lambda: 'Rest your eyes' in t.screen.text(), 15), 'no rest:\n' + t.screen.text())
        t.send(b'x')
        self.assertTrue(t.wait_for(lambda: not t.screen.in_alt, 10), 'key did not end the break')
        self.run_cmd(t, 'echo after-break', 'after-break')
        self.assertNotIn('xecho', t.screen.text())
        self.assertIn('ready', t.screen.text())

    def test_all_effects_via_bhb_now(self):
        t = self.start(BHB_INTERVAL_MINUTES='600')
        for effect in ('wormhole', 'supernova', 'dust'):
            t.send(('bhb-now %s\r' % effect).encode())
            self.assertTrue(t.wait_for(lambda: t.screen.in_alt, 15), effect)
            self.assertTrue(t.wait_for(lambda: not t.screen.in_alt, 15), effect)

    def test_day_filter_stops_breaks(self):
        t = self.start(BHB_ACTIVE_DAYS='Nope')
        self.run_cmd(t, 'echo quiet', 'quiet')
        t.pump(8)
        self.assertFalse(t.alt_seen, 'a break started outside the schedule')

    def test_status_command(self):
        t = self.start(BHB_INTERVAL_MINUTES='600')
        self.run_cmd(t, 'bhb-status', 'next break in')


if __name__ == '__main__':
    unittest.main(verbosity=2)
