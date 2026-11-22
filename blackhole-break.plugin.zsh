# Black-Hole Break for macOS Terminal.app (zsh)
#
# Timed eye breaks: after N minutes of active work, the text in your Terminal
# tab falls into a black hole (or a wormhole, a supernova, dust). The screen
# stays empty for a short rest, then the text comes back exactly as it was.
#
# Load it at the end of ~/.zshrc (every new Terminal window/tab loads it):
#     source ~/.config/blackhole-break/blackhole-break.plugin.zsh
#
# Settings (optional): set them in ~/.zshrc BEFORE the `source` line, e.g.
#     BHB_EFFECT=supernova
#     BHB_INTERVAL_MINUTES=10
# See the README for the full list.
#
# Nothing runs in the background: a break is checked once per second only
# while you are idle at the prompt (TMOUT / TRAPALRM). The animation runs with
# macOS's built-in JavaScript engine (osascript -l JavaScript).

[[ -o interactive ]] || return 0
[[ $TERM_PROGRAM == Apple_Terminal || -n $BHB_ANY_TERMINAL ]] || return 0
(( ${+_BHB_LOADED} )) && return 0
typeset -g _BHB_LOADED=1

zmodload zsh/datetime 2>/dev/null || return 0
zmodload zsh/system 2>/dev/null                     # zsystem flock
zmodload -F zsh/files b:zf_mv b:zf_rm 2>/dev/null   # mv / rm without a fork
autoload -Uz add-zsh-hook add-zle-hook-widget

typeset -g BHB_DIR=${${(%):-%x}:A:h}

# ------------------------------------------------------------------ settings
: ${BHB_ENABLED:=1}
: ${BHB_EFFECT:=blackHole}              # blackHole | wormhole | supernova | dust
: ${BHB_INTERVAL_MINUTES:=10}           # active minutes between breaks
: ${BHB_REST_SECONDS:=20}               # empty-screen rest
: ${BHB_ACTIVE_HOURS:=}                 # e.g. "09:00-12:30, 13:30-18:00"; empty = all day
: ${BHB_ACTIVE_DAYS:="Sun Mon Tue Wed Thu Fri Sat"}
: ${BHB_ACTIVE_WINDOW:=60}              # after a key press, this long still counts as active
: ${BHB_IDLE_SECONDS:=3}                # a due break waits for a typing pause this long
: ${BHB_AWAY_RESET:=300}                # no key press this long = a natural break (timer resets)
: ${BHB_COMMAND_MAX_MINUTES:=30}        # time in a running command (vim, ...) counts, up to this
: ${BHB_END_ON_KEY:=1}                  # a key ends the break early (the key is not typed)
: ${BHB_MESSAGE:="Rest your eyes. Look at something far away."}
: ${BHB_SPEED:=1}
: ${BHB_FPS:=30}
: ${BHB_HOLE_SCALE:=1}                  # hole / star size, 0.5 - 3 (it also grows with the window)
: ${BHB_COLORS:=256}                    # Terminal.app: 256; truecolor for other terminals
: ${BHB_FRONT_ONLY:=1}                  # only when this tab is in front (else: try again later)
: ${BHB_STATE_DIR:=${XDG_CACHE_HOME:-$HOME/.cache}/blackhole-break}
: ${BHB_DEBUG:=0}                       # 1 = write decisions to $BHB_STATE_DIR/debug.log

[[ -d $BHB_STATE_DIR ]] || command mkdir -p -- $BHB_STATE_DIR 2>/dev/null || return 0
[[ -e $BHB_STATE_DIR/lock ]] || : >> $BHB_STATE_DIR/lock     # zsystem flock needs the file

typeset -gF _bhb_last_input=$EPOCHREALTIME _bhb_cmd_start=0 _bhb_extra=0 _bhb_next_try=0
typeset -gi _bhb_busy=0 _bhb_due=0 _bhb_owner=0 _bhb_counting=1 _bhb_errors=0
typeset -gA _bhb_st

_bhb_debug() {
  (( BHB_DEBUG )) || return 0
  local ts
  strftime -s ts '%H:%M:%S' $EPOCHSECONDS
  print -r -- "$ts [$TTY] $*" >> $BHB_STATE_DIR/debug.log
}

_bhb_mv() { if (( $+builtins[zf_mv] )); then zf_mv -f "$@"; else command mv -f "$@"; fi }
_bhb_rm() { if (( $+builtins[zf_rm] )); then zf_rm -f "$@" 2>/dev/null; else command rm -f "$@" 2>/dev/null; fi }

# ------------------------------------------------------------------ activity
_bhb_touch() { _bhb_last_input=$EPOCHREALTIME }

_bhb_preexec() {
  _bhb_touch
  _bhb_cmd_start=$EPOCHREALTIME
}

_bhb_precmd() {
  if (( _bhb_cmd_start > 0 )); then
    local -F ran=$(( EPOCHREALTIME - _bhb_cmd_start )) cap=$(( BHB_COMMAND_MAX_MINUTES * 60 ))
    _bhb_cmd_start=0
    (( ran > 5 )) && _bhb_extra=$(( ran < cap ? ran : cap ))
  fi
  _bhb_touch
  _bhb_update_timer
}

# ------------------------------------------------------------------ time filter
_bhb_in_schedule() {
  emulate -L zsh
  setopt extendedglob
  local -i u
  strftime -s u '%u' $EPOCHSECONDS                     # 1 = Mon ... 7 = Sun
  local -a names=(Mon Tue Wed Thu Fri Sat Sun)
  [[ " $BHB_ACTIVE_DAYS " == *" ${names[u]} "* ]] || return 1
  [[ -z ${BHB_ACTIVE_HOURS//[[:space:]]/} ]] && return 0
  local hm range
  strftime -s hm '%H:%M' $EPOCHSECONDS
  local -i now=$(( 10#${hm[1,2]} * 60 + 10#${hm[4,5]} )) a b valid=0
  for range in ${(s:,:)BHB_ACTIVE_HOURS}; do
    range=${range//[[:space:]]/}
    [[ $range == (#b)([0-9](#c1,2)):([0-9](#c2))-([0-9](#c1,2)):([0-9](#c2)) ]] || continue
    valid=1
    a=$(( 10#$match[1] * 60 + 10#$match[2] ))
    b=$(( 10#$match[3] * 60 + 10#$match[4] ))
    (( a == b )) && return 0
    (( a < b && now >= a && now < b )) && return 0
    (( a > b && (now >= a || now < b) )) && return 0
  done
  (( valid )) && return 1 || return 0                  # no valid range: no filter
}

# ------------------------------------------------------------------ shared timer
# One counter for all tabs in $BHB_STATE_DIR/state (key value lines), with a lock.
_bhb_state_update() {
  local lockfd file=$BHB_STATE_DIR/state line k out=
  if (( $+builtins[zsystem] )); then
    # best effort: without the lock two tabs can lose one tick, nothing worse
    zsystem flock -t 1 -f lockfd $BHB_STATE_DIR/lock 2>/dev/null || { lockfd=; _bhb_debug "lock failed"; }
  fi
  _bhb_st=()
  if [[ -r $file ]]; then
    for line in "${(@f)"$(<$file)"}"; do
      [[ -n $line ]] && _bhb_st[${line%% *}]=${line#* }
    done
  fi
  "$@"
  for k in ${(k)_bhb_st}; do out+="$k ${_bhb_st[$k]}"$'\n'; done
  print -rn -- $out >| $file.$$ && _bhb_mv $file.$$ $file
  [[ -n $lockfd ]] && zsystem flock -u $lockfd 2>/dev/null
  return 0
}

_bhb_tick_edit() {
  local -F now=$EPOCHREALTIME
  local -F last_tick=${_bhb_st[last_tick]:-$now} active=${_bhb_st[active]:-0}
  local -F last_input=${_bhb_st[last_input]:-0} paused=${_bhb_st[paused_until]:-0}
  if (( _bhb_last_input > last_input )); then
    last_input=$_bhb_last_input
    _bhb_st[owner]=$TTY
  fi
  local -F dt=$(( now - last_tick ))
  (( dt < 0 )) && dt=0
  (( dt > 5 )) && dt=5                                  # a sleeping Mac does not count
  local -i counting=$_bhb_counting
  (( now < paused )) && counting=0
  if (( counting && now - last_input <= BHB_ACTIVE_WINDOW )); then
    (( active += dt ))
  elif (( now - last_input >= BHB_AWAY_RESET )); then
    active=0
  fi
  if (( _bhb_extra > 0 && counting )); then
    (( active += _bhb_extra ))
  fi
  _bhb_extra=0
  _bhb_st[active]=$active
  _bhb_st[last_tick]=$now
  _bhb_st[last_input]=$last_input
  _bhb_st[paused_until]=$paused
  _bhb_due=$(( counting && active >= BHB_INTERVAL_MINUTES * 60 ))
  [[ ${_bhb_st[owner]} == $TTY ]] && _bhb_owner=1 || _bhb_owner=0
  _bhb_debug "tick active=$active dt=$dt counting=$counting due=$_bhb_due owner=$_bhb_owner"
}

_bhb_reset_edit() {
  _bhb_st[active]=0
  _bhb_st[last_tick]=$EPOCHREALTIME
  _bhb_st[last_break]=$EPOCHREALTIME
}

_bhb_update_timer() {
  (( BHB_ENABLED )) || return 1
  _bhb_in_schedule && _bhb_counting=1 || _bhb_counting=0
  _bhb_state_update _bhb_tick_edit
}

# ------------------------------------------------------------------ the break
_bhb_break() {
  emulate -L zsh
  _bhb_busy=1
  local stop=$BHB_STATE_DIR/stop.$$ result=$BHB_STATE_DIR/result.$$ key res=
  local -a where
  if [[ -n $BHB_TEST_SCREEN ]]; then                    # tests: screen text from a file
    where=(screen=$BHB_TEST_SCREEN cols=$COLUMNS rows=$LINES front=0)
  else
    where=(tty=$TTY front=$BHB_FRONT_ONLY)
  fi
  _bhb_rm $stop $result
  osascript -l JavaScript $BHB_DIR/blackhole-break.js $where \
    effect=$BHB_EFFECT rest=$BHB_REST_SECONDS speed=$BHB_SPEED fps=$BHB_FPS scale=$BHB_HOLE_SCALE \
    colors=$BHB_COLORS "message=$BHB_MESSAGE" stop=$stop result=$result \
    </dev/null >/dev/null 2>>$BHB_STATE_DIR/error.log &!
  local -i pid=$!
  while kill -0 $pid 2>/dev/null; do
    if read -s -k 1 -t 0.1 key 2>/dev/null; then       # the key is used up here: not typed
      (( BHB_END_ON_KEY )) && : >| $stop
    fi
  done
  [[ -r $result ]] && res=$(<$result)
  _bhb_debug "break result: '$res'"
  _bhb_rm $stop $result
  case $res in
    done|ended)
      _bhb_errors=0
      _bhb_state_update _bhb_reset_edit ;;
    skip)
      _bhb_next_try=$(( EPOCHREALTIME + 30 )) ;;      # tab not in front: try again later
    *)
      print -n '\e[0m\e[?25h\e[?1049l' >/dev/tty       # make sure the screen is back
      (( ++_bhb_errors >= 3 )) && BHB_ENABLED=0
      _bhb_next_try=$(( EPOCHREALTIME + 300 ))
      print -r -- "$(strftime '%F %T' $EPOCHSECONDS) break failed: '$res'" >> $BHB_STATE_DIR/error.log ;;
  esac
  _bhb_busy=0
  zle && zle reset-prompt
  return 0
}

_bhb_check() {
  (( _bhb_busy || ! BHB_ENABLED )) && return 0
  (( EPOCHREALTIME < _bhb_next_try )) && return 0
  _bhb_update_timer || return 0
  (( _bhb_due && _bhb_owner )) || return 0
  (( EPOCHREALTIME - _bhb_last_input >= BHB_IDLE_SECONDS )) || return 0
  _bhb_break
}

# Checked once per second while the prompt waits for input.
if (( ${+functions[TRAPALRM]} )) && (( ! ${+functions[_bhb_prev_TRAPALRM]} )); then
  functions -c TRAPALRM _bhb_prev_TRAPALRM 2>/dev/null
fi
TRAPALRM() {
  (( ${+functions[_bhb_prev_TRAPALRM]} )) && _bhb_prev_TRAPALRM "$@"
  _bhb_check
}
(( ${TMOUT:-0} > 0 )) || TMOUT=1

add-zsh-hook preexec _bhb_preexec
add-zsh-hook precmd _bhb_precmd
add-zle-hook-widget line-pre-redraw _bhb_touch 2>/dev/null

# ------------------------------------------------------------------ optional commands
# You never need these; they are here to try an effect or to pause.
bhb-now() {                       # take a break now (or: bhb-now supernova)
  local BHB_EFFECT=${1:-$BHB_EFFECT} BHB_FRONT_ONLY=0
  _bhb_break
}
bhb-pause() {                     # pause breaks for N minutes (default 60)
  local -F until=$(( EPOCHREALTIME + ${1:-60} * 60 ))
  _bhb_pause_edit() { _bhb_st[paused_until]=$until }
  _bhb_state_update _bhb_pause_edit
  print "Black-Hole Break paused until $(strftime '%H:%M' ${until%.*})"
}
bhb-resume() {
  _bhb_resume_edit() { _bhb_st[paused_until]=0 }
  _bhb_state_update _bhb_resume_edit && print "Black-Hole Break resumed"
}
bhb-status() {
  _bhb_update_timer
  local -F left=$(( BHB_INTERVAL_MINUTES * 60 - ${_bhb_st[active]:-0} ))
  (( left < 0 )) && left=0
  local -i secs=$left
  print "Black-Hole Break: effect $BHB_EFFECT, next break in $(( secs / 60 ))m $(( secs % 60 ))s of active time"
  (( _bhb_counting )) || print "  outside BHB_ACTIVE_HOURS / BHB_ACTIVE_DAYS"
  (( EPOCHREALTIME < ${_bhb_st[paused_until]:-0} )) && print "  paused"
  (( BHB_ENABLED )) || print "  disabled (BHB_ENABLED=0)"
}
