"""Drive the actual executable in a PTY. No injected timers or disabled animation."""
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

job = json.loads(sys.argv[1])
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, job.get('columns', 100), 0, 0))
child = subprocess.Popen(job['argv'], stdin=slave, stdout=slave, stderr=slave, env=os.environ.copy(), start_new_session=True)
os.close(slave)
output = ''
step = 0
start = time.monotonic()
consumed = 0
try:
    while time.monotonic() - start < 25:
        if select.select([master], [], [], .1)[0]:
            try:
                data = os.read(master, 65536)
            except OSError as err:
                if err.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            output += data.decode('utf8', errors='replace')
        plain = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', output)
        if step < len(job['steps']):
            match = plain.find(job['steps'][step]['wait'], consumed)
            if match >= 0:
                consumed = match + len(job['steps'][step]['wait'])
                os.write(master, job['steps'][step]['send'].encode())
                step += 1
        if child.poll() is not None:
            # Drain any final terminal output before reporting.
            if not select.select([master], [], [], .1)[0]:
                break
    if child.poll() is None:
        print(json.dumps({"timeout_output": output}), file=sys.stderr)
        child.terminate()
    code = child.wait(timeout=3)
    print(json.dumps({'code': code, 'steps_completed': step, 'output': re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', output)}))
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
