"""Render the official 60-second v1.2.0 film with a 1.1 to 1.2 opening.

All illustrated UI data is fictional. No new GPU diagnosis is announced.
"""
import argparse
from functools import lru_cache
from pathlib import Path
import subprocess

from PIL import Image, ImageDraw, ImageFont

W,H,FPS,DURATION=1280,720,25,60
BG='#f5f5f7';INK='#1d1d1f';MUTED='#626268';LINE='#e5e5e7'
BLUE='#0071e3';ORANGE='#9a4d0b';GREEN='#256644';NAVY='#08090c'
REGULAR=BOLD=None
SCENES=[(0,6),(6,14),(14,22),(22,30),(30,38),(38,47),(47,54),(54,60)]
NAME='CVML-GPU-Timeline-v1.2.0-60s'

def clamp(v):return max(0,min(1,v))
def ease(v):return 1-(1-clamp(v))**3
@lru_cache(None)
def font(size,bold=False):
    f=ImageFont.truetype(BOLD if bold else REGULAR,size)
    try:
        axes=f.get_variation_axes()
        f.set_variation_by_axes([(700 if bold else 400) if axis['name']==b'Weight' else axis['default'] for axis in axes])
    except (OSError,AttributeError):pass
    return f
def text(d,x,y,value,size=22,color=INK,bold=False,anchor='lt',width=None):
    value=str(value)
    if width is not None:
        while font(size,bold).getlength(value)>width and size>12:size-=1
    d.text((round(x),round(y)),value,font=font(size,bold),fill=color,anchor=anchor)
def box(d,rect,fill='white',radius=12,outline=None):
    d.rounded_rectangle(tuple(round(v) for v in rect),radius,fill=fill,outline=outline,width=1)
def card(d,x,y,w,h):
    box(d,(x,y+4,x+w,y+h+4),'#e9eef4',14)
    box(d,(x,y,x+w,y+h),'white',14,LINE)
def pill(d,x,y,value,tone='blue',size=16):
    palettes={'blue':('#eaf1fc',BLUE),'orange':('#fff0dc',ORANGE),'green':('#e8f4ec',GREEN),'gray':('#eef1f5','#5c6e85')}
    bg,fg=palettes[tone];w=font(size,True).getlength(value)+24
    box(d,(x,y,x+w,y+31),bg,6);text(d,x+12,y+7,value,size,fg,True);return w
def line(d,x,y,w,value,color=BLUE):
    box(d,(x,y,x+w,y+6),'#e8edf4',3)
    if value>0:box(d,(x,y,x+w*min(1,value),y+6),color,3)
def shell(im,t,dark=False):
    d=ImageDraw.Draw(im);color='#a6b7ce' if dark else '#6e7e92'
    text(d,64,31,'CVML / GPU TIMELINE',16,color,True)
    text(d,1216,31,'v1.2.0 / NOW AVAILABLE',16,color,True,'rt')
    text(d,64,675,'화면 재구성 · 가상 데이터',14,color)
    text(d,1216,675,f'{int(t):02d} / 60 SEC',14,color,True,'rt')
    line(d,64,704,1152,t/60,'#8fb4ec' if dark else BLUE)
def heading(d,tag,title,subtitle,u):
    shift=(1-ease(u/.55))*13
    text(d,76,91+shift,tag,16,BLUE,True)
    text(d,72,132+shift,title,44,INK,True,width=1130)
    text(d,76,200+shift,subtitle,22,MUTED,width=1128)
def light():
    im=Image.new('RGB',(W,H),BG);return im,ImageDraw.Draw(im)
def button(d,x,y,label,width=125,primary=False):
    box(d,(x,y,x+width,y+39),BLUE if primary else '#f5f8fc',6,BLUE if primary else '#c8d4e3')
    text(d,x+width/2,y+11,label,15,'white' if primary else BLUE,True,'mt',width=width-14)
def mini_nav(d,x,y,active='현재 현황'):
    for label in ['현재 현황','타임라인','자원·비용','서버','택배 조회','더보기']:
        text(d,x,y,label,15,INK if label==active else MUTED,label==active)
        w=font(15).getlength(label)
        if label==active:d.line((x,y+29,x+w,y+29),fill=BLUE,width=3)
        x+=w+33

def intro_hook(u,t):
    im=Image.new('RGB',(W,H),NAVY);d=ImageDraw.Draw(im)
    for i in range(5):d.ellipse((760+i*39,110+i*48,1370-i*19,810-i*13),outline='#233b5c',width=1)
    pill(d,76,112,'v1.2.0','blue',20)
    offset=(1-ease(u/.9))*22
    text(d,72,213+offset,'필요한 정보가,',65,'white',True)
    text(d,72,300+offset,'먼저 보이도록.',65,'white',True)
    text(d,78,435,'CVML GPU Timeline',29,'#afc5e1',True)
    text(d,78,482,'실험 현황부터 연구실 장비 배송까지.',25,'#afc5e1')
    for i,(label,sub,color) in enumerate([('GPU','누가 · 무엇을 · 언제까지',BLUE),('API','진행률 · 예상 종료',ORANGE),('ORDER','주문 · 배송 · 수령',GREEN)]):
        x=878+(1-ease((u-.35-i*.18)/.7))*100;y=190+i*118
        box(d,(x,y,x+330,y+96),'#203550',12,'#355070')
        text(d,x+20,y+17,label,22,'#b9d4f8',True)
        text(d,x+20,y+54,sub,17,'#d6e2f2')
    shell(im,t,True);return im

def version_upgrade(u,t):
    im=Image.new('RGB',(W,H),NAVY);d=ImageDraw.Draw(im)
    progress=ease((u-.85)/1.15)
    # A clipped odometer rolls the final digit while the prefix stays fixed.
    size=242;prefix='1.';prefix_width=font(size,True).getlength(prefix)
    digit_width=round(font(size,True).getlength('2'))+22
    x=round((W-prefix_width-digit_width)/2);y=211;stride=292
    radius=220+ease(u/2.5)*80
    for extra,color in [(0,'#152135'),(38,'#111a28'),(78,'#0d131d')]:
        d.ellipse((W/2-radius-extra,H/2-radius-extra,W/2+radius+extra,H/2+radius+extra),outline=color,width=1)
    text(d,W/2,123,'A NEW CHAPTER',18,'#99a5b6',True,'mt')
    text(d,x,y,prefix,size,'white',True)
    digits=Image.new('RGB',(digit_width,stride),NAVY);dd=ImageDraw.Draw(digits)
    text(dd,0,-progress*stride,'1',size,'white',True)
    text(dd,0,stride-progress*stride,'2',size,'#64afff',True)
    im.paste(digits,(round(x+prefix_width),y))
    text(d,W/2,537,'1.1  →  1.2',24,'#9fa9b8',True,'mt')
    text(d,W/2,583,'더 명료해진 연구실의 하루.',24,'#d2d2d7',False,'mt')
    shell(im,t,True);return im

def intro(u,t):
    if u<3.0:return version_upgrade(u,t)
    hook=intro_hook(u-3.0,t)
    if u<3.5:return Image.blend(version_upgrade(3.0,t),hook,ease((u-3.0)/.5))
    return hook

def current(u,t):
    im,d=light();heading(d,'01 / CURRENT STATUS','화면을 열면, 필요한 정보부터.','여유 GPU와 실행 중 실험, 먼저 확인하세요.',u)
    mini_nav(d,86,255)
    for i,(label,value,unit) in enumerate([('현재 여유','1','/ 4 GPU'),('점유','2','GPU'),('확인 필요','1','GPU'),('API 실행','2','실험')]):
        x=76+i*286;card(d,x,300,269,79)
        text(d,x+18,315,label,15,MUTED)
        text(d,x+18,344,value,26,BLUE,True);text(d,x+61,352,unit,16,MUTED)
    card(d,76,397,1128,245)
    columns=[(95,'서버'),(250,'GPU'),(340,'상태'),(461,'실험 / 담당자'),(758,'진행률'),(860,'GPU · VRAM'),(1071,'종료 예정')]
    for x,label in columns:text(d,x,414,label,14,MUTED)
    rows=[('Server A','GPU 0','점유 중','exp69 · Qwen3-8B','seed 0 · 연구원 A','56%','100% · 42/48 GiB','오늘 18:40'),('Server B','GPU 0','점유 중','exp46 · AIME / 8B','GEPA · 연구원 B','72%','100% · 21/24 GiB','오늘 17:20'),('','GPU 1','여유','등록된 실행 실험 없음','','—','0% · 1/24 GiB','—'),('Server C','GPU 0','확인 필요','새 상태 확인 필요','','—','마지막 수신','확인 필요')]
    for i,row in enumerate(rows):
        y=449+i*46;d.line((95,y-7,1185,y-7),fill=LINE,width=1)
        server,gpu,status,job,meta,pct,util,eta=row
        text(d,95,y,server,16,INK,True);text(d,250,y,gpu,16)
        pill(d,340,y-1,status,'green' if status=='여유' else 'orange' if status=='확인 필요' else 'blue',13)
        text(d,461,y,job,16,INK,True,width=275);text(d,461,y+22,meta,12,MUTED)
        text(d,758,y,pct,17,INK,True);text(d,860,y,util,14,MUTED,width=194);text(d,1071,y,eta,15,INK,True,width=116)
    shell(im,t);return im

def api(u,t):
    im,d=light();heading(d,'02 / GPU & API','GPU와 API, 각자의 목록으로.','짧아진 실험명 옆에 진행률과 예상 종료를 함께.',u)
    card(d,76,275,1128,365)
    pill(d,101,296,'GPU 4','gray',17);pill(d,210,296,'API 2','blue',17)
    text(d,1175,306,'API 실험',21,INK,True,'rt')
    for i,(title,meta,pct,eta) in enumerate([('exp75 · AIME / gpt-oss-20b','GEPA · seed 0 · 연구원 A',63,'오늘 17:30'),('exp69 · 문제 생성 API','seed 1 · 연구원 B',38,'오늘 19:10')]):
        y=356+i*90;d.line((100,y-10,1180,y-10),fill=LINE,width=1)
        text(d,105,y,title,21,INK,True,width=550);text(d,106,y+34,meta,16,MUTED)
        pill(d,669,y,'실행 중','blue',15)
        text(d,840,y,str(pct)+'%',22,INK,True);line(d,840,y+37,120,pct/100*ease(u/1.1))
        text(d,1172,y,eta,20,INK,True,'rt');text(d,1172,y+34,'예상 종료',14,MUTED,anchor='rt')
    box(d,(100,544,1180,615),'#eef4fc',9)
    text(d,121,561,'연구실 공용 키 · 사용 24%',18,BLUE,True)
    text(d,1160,561,'남은 한도 $760 · 76%',21,BLUE,True,'rt')
    line(d,122,599,1036,.24*ease(u/1.4))
    shell(im,t);return im

def detail(u,t):
    im,d=light();heading(d,'03 / TIMELINE & DETAILS','흐름을 보고, 눌러서 자세히.','일정과 상세 정보가 자연스럽게 이어집니다.',u)
    card(d,76,280,680,345)
    for i,label in enumerate(['09:00','12:00','15:00','18:00']):
        x=240+i*150;text(d,x,306,label,14,MUTED);d.line((x,338,x,598),fill=LINE,width=1)
    for i,(label,title,w,color) in enumerate([('GPU 0','exp46 · AIME',380,'#dce9fa'),('GPU 1','exp69 · 생성',240,'#e2eaf5'),('API 0','API 평가',340,'#dce9fa')]):
        y=359+i*74;text(d,101,y+14,label,17,INK,True);box(d,(240,y,240+w,y+43),color,7)
        text(d,255,y+13,title,16,BLUE,True)
    x=787+(1-ease(u/.8))*90;card(d,x,280,418,345)
    text(d,x+25,303,'EXPERIMENT',13,MUTED,True)
    text(d,x+25,342,'exp46 · AIME · 8B GEPA',22,INK,True,width=368)
    text(d,x+25,376,'정답 문제 교체 · seed 0',20,INK,True)
    for i,(label,value) in enumerate([('담당자','연구원 A'),('실행 자원','Server A · GPU 0'),('진행률','56%'),('종료 예정','오늘 18:40')]):
        y=431+i*34;text(d,x+26,y,label,16,MUTED);text(d,x+392,y,value,17,INK,True,'rt')
    button(d,x+25,577,'실험 ID 복사',368)
    shell(im,t);return im

def statistics(u,t):
    im,d=light();heading(d,'04 / RESOURCES','현재 수치에서, 사용 추이까지.','24시간 · 7일 · 30일의 자원 기록을 비교하세요.',u)
    values=[('GPU 활동률','96%',[91,94,87,100,98,94,100,96]),('CPU 사용률','1.2%',[2,1,3,2,1,2,1,1.2]),('RAM 사용률','24%',[19,19,20,20,22,23,24,24]),('I/O 요청 지연','3.1 ms',[1,2,1,4,2,1,2,3.1])]
    for i,(label,amount,points) in enumerate(values):
        x=76+i*286;card(d,x,286,269,256)
        text(d,x+21,308,label,19,INK,True);text(d,x+20,354,amount,37,BLUE,True)
        for k in range(3):d.line((x+23,425+k*36,x+246,425+k*36),fill=LINE,width=1)
        p=[(x+23+j*223/7,497-v/100*72) for j,v in enumerate(points)]
        count=max(2,int(len(p)*ease(u/1.3)))
        d.line(p[:count],fill=BLUE,width=3,joint='curve')
        text(d,x+23,512,'00시',12,MUTED);text(d,x+246,512,'24시',12,MUTED,anchor='rt')
    box(d,(76,563,1204,641),'#fff3e2',10)
    text(d,100,578,'CPU · RAM · I/O의 지속 대기 구간과 판단 근거 확인',22,ORANGE,True,width=1080)
    text(d,101,613,'GPU 활동률만으로 연산 효율이나 정확한 병목을 확정하지 않습니다.',16,'#7e6b51')
    shell(im,t);return im

def orders(u,t):
    im,d=light();heading(d,'05 / LAB ORDERS','결제한 장비도, 한눈에.','여러 주문을 공용 목록에 모으고 배송 상태를 확인하세요.',u)
    rows=[('운송장 대기','gray','측정용 마이크','4개','택배사 미정','운송장은 나중에 입력하세요.','등록 완료'),('배송 출발','orange','오디오 인터페이스','1개','CJ대한통운 · 가상 운송장','성북 배송점','마지막 이동 09:12'),('배송 완료','green','마이크 고정 브래킷','4개','한진택배 · 가상 운송장','배달 완료','마지막 이동 11:20')]
    for i,(status,tone,name,qty,courier,location,stamp) in enumerate(rows):
        x=76+i*384;y=294+(1-ease((u-i*.12)/.7))*15;card(d,x,y,360,319)
        pill(d,x+20,y+19,status,tone,16);text(d,x+338,y+25,qty,17,MUTED,anchor='rt')
        text(d,x+20,y+80,name,24,INK,True,width=320)
        d.line((x+20,y+128,x+340,y+128),fill=LINE,width=1)
        text(d,x+20,y+147,courier,16,MUTED,width=320)
        text(d,x+20,y+187,location,19,INK,True,width=320)
        text(d,x+20,y+224,stamp,14,MUTED)
        button(d,x+20,y+266,'수정' if i==0 else '배송 조회',145)
        button(d,x+184,y+266,'보관' if i==2 else '수령 완료',155)
    text(d,78,630,'배송 출발은 주황색 · 배송 완료는 초록색',18,MUTED)
    shell(im,t);return im

def workflow(u,t):
    im,d=light();heading(d,'06 / REGISTER & FOLLOW','결제한 날 등록하고, 운송장은 나중에.','장비명 · 수량 · 메모로 먼저 등록할 수 있어요.',u)
    card(d,76,280,620,359)
    text(d,103,304,'장비·택배 추가',23,INK,True)
    text(d,103,350,'장비명',15,MUTED);text(d,584,350,'수량',15,MUTED)
    box(d,(101,375,561,423),'white',6,'#bdcadb');box(d,(580,375,670,423),'white',6,'#bdcadb')
    text(d,115,389,'측정용 마이크',20);text(d,601,389,'4',20)
    text(d,103,448,'운송장 번호 · 선택',15,MUTED)
    box(d,(101,475,670,523),'white',6,'#bdcadb')
    text(d,116,489,'아직 없으면 비워 두세요.' if u<3 else '1234 5678 9012',19,MUTED if u<3 else INK)
    button(d,101,547,'공용 목록에 추가',569,True)
    text(d,103,609,'등록·수정은 관리자 로그인 · 등록 정보는 공개 공유',14,MUTED,width=568)
    for i,(title,sub) in enumerate([('장비와 수량 등록','운송장 없이도 주문 기록'),('전체 배송 조회','여러 건의 현재 상태 확인'),('수령 완료 · 보관','지난 주문은 보관함에서')]):
        x=744;y=314+i*105
        box(d,(x,y,x+46,y+46),'#e5eefb',23);text(d,x+23,y+12,str(i+1),22,BLUE,True,'mt')
        text(d,x+65,y,title,25,INK,True,width=385);text(d,x+65,y+39,sub,18,MUTED,width=385)
    shell(im,t);return im

def ending(u,t):
    im=Image.new('RGB',(W,H),NAVY);d=ImageDraw.Draw(im)
    pill(d,76,115,'v1.2.0 · NOW AVAILABLE','blue',20)
    text(d,72,211,'실험도, 장비도.',68,'white',True)
    text(d,72,300,'한눈에.',68,'white',True)
    text(d,78,416,'새 대시보드 · GPU / API · 연구실 주문 배송',26,'#b8cce5',width=1120)
    box(d,(77,490,1204,558),'#d9e8fc',12)
    text(d,103,512,'shxyzn.github.io/gpu-timeline/',28,NAVY,True,width=1076)
    text(d,79,596,'designed by psh in suwon',23,'#adc3df')
    shell(im,t,True);return im

FUNCTIONS=[intro,current,api,detail,statistics,orders,workflow,ending]
def frame(t):
    index=next((i for i,(start,end) in enumerate(SCENES) if start<=t<end),7)
    u=t-SCENES[index][0];im=FUNCTIONS[index](u,t)
    if index and u<.32:
        previous=FUNCTIONS[index-1](SCENES[index-1][1]-SCENES[index-1][0],t)
        im=Image.blend(previous,im,ease(u/.32))
    return im
def main():
    global REGULAR,BOLD
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--regular',required=True);parser.add_argument('--bold',required=True)
    parser.add_argument('--output',default='dist/media');parser.add_argument('--preview',action='store_true')
    args=parser.parse_args();REGULAR=args.regular;BOLD=args.bold
    out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
    if args.preview:
        sheet=Image.new('RGB',(1280,1440),BG)
        for i,t in enumerate([4,11,19,27,35,44,51,58]):
            shot=frame(t);shot.save(out/f'v120-scene-{i+1:02d}.png')
            sheet.paste(shot.resize((640,360),Image.Resampling.LANCZOS),((i%2)*640,(i//2)*360))
        sheet.save(out/'storyboard-v120.png')
        strip=Image.new('RGB',(1280,240),NAVY)
        for i,t in enumerate([.6,1.35,2.6]):strip.paste(frame(t).resize((426,240),Image.Resampling.LANCZOS),(i*426,0))
        strip.save(out/'intro-v120.png');return
    command=['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-vcodec','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-an','-c:v','libx264','-preset','fast','-crf','19','-pix_fmt','yuv420p','-movflags','+faststart',str(out/(NAME+'.mp4'))]
    process=subprocess.Popen(command,stdin=subprocess.PIPE)
    for i in range(FPS*DURATION):
        process.stdin.write(frame(i/FPS).tobytes())
        if i%(FPS*5)==0:print(f'v1.2.0: {i/FPS:.0f}s / 60s',flush=True)
    process.stdin.close()
    if process.wait():raise RuntimeError('Video encoding failed')
    frame(2.6).save(out/'poster-v1.2.0.jpg',quality=92)
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(out/(NAME+'.mp4')),'-filter_complex','fps=10,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3','-loop','0',str(out/(NAME+'.gif'))],check=True)
    print('v1.2.0 MP4 and GIF rendered.',flush=True)

if __name__=='__main__':main()
