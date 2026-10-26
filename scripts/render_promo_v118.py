"""Render the 60-second release film from drawn UI examples (Pillow + ffmpeg).

python scripts/render_promo_v118.py --regular /path/NotoSansKR-Regular.ttf \
  --bold /path/NotoSansKR-Bold.ttf --output dist/media
Use --preview for a contact sheet only. All shown measurements are fictional.
"""
from pathlib import Path
from functools import lru_cache
from PIL import Image, ImageDraw, ImageFont
import argparse
import math
import subprocess

W,H,FPS,DURATION=1280,720,25,60
BG='#F6F6FC'; INK='#302A45'; MUTED='#7F7B93'; PURPLE='#7963C9'; MINT='#49D1A5'; LINE='#E7E3F1'; DARK='#191527'; AMBER='#C3913E'
SCENES=[(0,6),(6,13),(13,21),(21,30),(30,38),(38,47),(47,54),(54,60)]
REGULAR=BOLD=None

@lru_cache(None)
def font(size,bold=False):return ImageFont.truetype(BOLD if bold else REGULAR,size)
def clamp(v):return max(0,min(1,v))
def ease(v):return 1-(1-clamp(v))**3
def text(d,x,y,s,size=24,color=INK,bold=False,anchor='lt'):
    d.text((int(x),int(y)),str(s),font=font(size,bold),fill=color,anchor=anchor)
def box(d,rect,color='white',radius=18,border=None):
    d.rounded_rectangle(tuple(round(v) for v in rect),radius=radius,fill=color,outline=border,width=1)
def badge(d,x,y,s,color='#EFEBFA',fg=PURPLE,size=17):
    width=font(size,True).getlength(s)+30
    box(d,(x,y,x+width,y+35),color,10);text(d,x+15,y+9,s,size,fg,True)
    return width
def card(d,x,y,w,h):
    box(d,(x,y+7,x+w,y+h+7),'#ECE8F4',23)
    box(d,(x,y,x+w,y+h),'white',23,LINE)
def shell(im,t,dark=False):
    d=ImageDraw.Draw(im);fg='#ACA1C1' if dark else '#9690A7'
    text(d,64,30,'CVML / GPU TIMELINE',15,fg,True)
    text(d,1216,30,'v1.1.8',16,fg,True,'rt')
    text(d,64,674,'기능 예시 · 가상 데이터',14,fg)
    text(d,1216,674,f'60 SEC / {int(t):02}',14,fg,True,'rt')
    d.rectangle((64,704,1216,707),fill='#373045' if dark else '#E4DFEF')
    d.rectangle((64,704,64+1152*t/60,707),fill=MINT if dark else PURPLE)
def header(d,tag,title,subtitle,u):
    offset=(1-ease(u/.5))*18
    text(d,73,91+offset,tag,17,PURPLE,True)
    text(d,70,132+offset,title,49,INK,True)
    text(d,74,204+offset,subtitle,23,MUTED)
def spark(d,x,y,w,h,values,u,color=PURPLE,maxv=100):
    for frac in (0,.5,1):d.line((x,y+h*frac,x+w,y+h*frac),fill=LINE,width=1)
    visible=clamp(u/1.8)*(len(values)-1)
    points=[]
    for i,value in enumerate(values):
        if i>visible:break
        points.append((x+w*i/(len(values)-1),y+h-h*value/maxv))
    i=int(visible)
    if i<len(values)-1:
        v=values[i]+(values[i+1]-values[i])*(visible-i)
        points.append((x+w*visible/(len(values)-1),y+h-h*v/maxv))
    if len(points)>1:d.line(points,fill=color,width=4,joint='curve')

def intro(u,t):
    im=Image.new('RGB',(W,H),DARK);d=ImageDraw.Draw(im)
    badge(d,74,111,'NEW RELEASE / v1.1.8','#352B4D','#CABCF0',19)
    text(d,71,203,'우리 연구실 자원,',65,'white',True)
    text(d,71,291,'어디에 더 필요할까?',65,'white',True)
    text(d,77,410,'사용량을 보고, 대기 구간을 찾고.',29,'#BFB1D4')
    text(d,77,456,'증설의 근거를 모으다.',29,'#BFB1D4')
    labels=['GPU','CPU','RAM','I/O']
    for i,label in enumerate(labels):
        y=195+i*89;x=950+(1-ease((u-.4-i*.12)/.8))*100
        box(d,(x,y,x+240,y+63),['#423361','#332E4D','#25493E','#343345'][i],15)
        text(d,x+25,y+21,label,24,MINT if i==2 else '#D9CEF1',True)
    shell(im,t,True);return im

def timeline(u,t):
    im=Image.new('RGB',(W,H),BG);d=ImageDraw.Draw(im)
    header(d,'01 / GPU + API TIMELINE','실험마다, 끝나는 시간이 보여요.','여러 서버의 GPU와 외부 API 실험을 한 화면에.',u)
    card(d,76,281,1128,339)
    for i,label in enumerate(['09:00','12:00','15:00','18:00']):
        x=331+i*257
        text(d,x,311,label,17,MUTED)
        d.line((x,347,x,586),fill=LINE,width=1)
    rows=[('Server A / GPU 0','Qwen · 학습','16:30 예정',0,620,PURPLE),
          ('Server B / GPU 1','GEPA · 평가','18:00 예정',90,719,'#5E9D88'),
          ('Server A / API 0','문제 생성 · API','14:00 예정',0,425,'#A58ACB')]
    for i,(label,name,eta,offset,width,color) in enumerate(rows):
        y=367+i*80
        text(d,103,y+15,label,18,INK,True)
        x=331+offset;shown=max(2,width*ease((u-.25-i*.15)/1.1))
        box(d,(x,y,x+shown,y+53),color,10)
        if shown>350:
            text(d,x+15,y+17,name,18,'white',True)
            text(d,x+shown-14,y+17,eta,17,'white',anchor='rt')
    shell(im,t);return im

def tokens(u,t):
    im=Image.new('RGB',(W,H),BG);d=ImageDraw.Draw(im)
    header(d,'02 / API BUDGET','한도는 막대 하나로.','사용한 만큼 채우고, 남은 비율을 함께.',u)
    card(d,76,284,1128,317)
    text(d,108,316,'OpenRouter · 연구실 공용',25,INK,True)
    p=ease((u-.5)/1.5);used=round(900*p);percent=used/10
    text(d,108,382,f'${used:,}',54,INK,True)
    text(d,370,410,'/ $1,000',25,MUTED)
    text(d,1163,408,f'사용 {percent:.0f}%',28,AMBER,True,'rt')
    box(d,(109,476,1164,490),'#EEEAF3',7)
    if percent:box(d,(109,476,109+1055*percent/100,490),AMBER,7)
    text(d,108,528,'키에 설정한 금액 한도 · USD',20,MUTED)
    text(d,1164,525,f'${1000-used:,} 남음 · {100-percent:.0f}%',25,INK,True,'rt')
    shell(im,t);return im

def statistics(u,t):
    im=Image.new('RGB',(W,H),BG);d=ImageDraw.Draw(im)
    header(d,'03 / RESOURCE HISTORY','현재 상태에서, 사용 추이로.','최근 24시간 · 7일 · 30일을 비교하세요.',u)
    labels=[('GPU 활동률','28%',[65,76,50,30,22,27,19,28]),('CPU 사용률','43%',[25,32,43,58,60,41,35,43]),('RAM 사용률','97%',[35,42,58,78,86,93,96,97]),('I/O 요청 지연','38 ms',[2,4,3,8,18,24,33,38])]
    for i,(name,value,values) in enumerate(labels):
        x=76+i*286
        card(d,x,293,269,316)
        text(d,x+22,319,name,20,INK,True)
        text(d,x+22,365,value,41,PURPLE if i!=2 else AMBER,True)
        spark(d,x+25,444,219,94,values,max(0,u-.5-i*.15),AMBER if i==2 else PURPLE,maxv=50 if i==3 else 100)
        text(d,x+25,556,'00시',14,MUTED)
        text(d,x+244,556,'24시',14,MUTED,anchor='rt')
    shell(im,t);return im

def storage(u,t):
    im=Image.new('RGB',(W,H),BG);d=ImageDraw.Draw(im)
    header(d,'04 / CAPACITY & WAIT','용량과 속도는 따로.','공간이 찼는지, 읽고 쓰느라 기다리는지.',u)
    card(d,76,285,540,324);card(d,638,285,566,324)
    text(d,105,316,'저장장치 용량',24,INK,True)
    badge(d,105,363,'/data · 65% 사용','#F0EBF9',PURPLE,20)
    box(d,(107,439,582,451),'#EEEBF3',7)
    box(d,(107,439,107+475*.65*ease((u-.4)/1.3),451),PURPLE,7)
    text(d,108,492,'2.8 / 8.0 TiB 남음',28,INK,True)
    text(d,108,548,'남은 용량 확인',19,MUTED)
    text(d,668,316,'동시간대 I/O 지연',24,INK,True)
    text(d,668,380,'38 ms',48,AMBER,True)
    text(d,668,457,'I/O 대기 PSI 22%',27,INK,True)
    text(d,668,513,'용량이 남아 있어도',23,MUTED)
    text(d,668,549,'실험이 기다릴 수 있어요.',23,MUTED)
    shell(im,t);return im

def bottleneck(u,t):
    im=Image.new('RGB',(W,H),BG);d=ImageDraw.Draw(im)
    header(d,'05 / BOTTLENECK CANDIDATES','의심 구간에는, 근거를.','순간적인 급등보다 2분 이상 이어진 자원 대기.',u)
    card(d,76,277,1128,350)
    badge(d,104,304,'Server B · RAM 부족 의심','#FFF1D7','#906323',19)
    left=[('가용 메모리','1.9 / 64 GiB'),('스왑 입출력','26 MiB/s'),('메모리 대기 PSI','14%')]
    for i,(label,val) in enumerate(left):
        y=374+i*67
        text(d,106,y,label,21,MUTED)
        text(d,590,y,val,24,INK,True,'rt')
        d.line((106,y+43,590,y+43),fill=LINE,width=1)
    d.line((638,366,638,578),fill=LINE,width=1)
    text(d,674,371,'먼저 확인할 것',23,PURPLE,True)
    text(d,674,416,'worker · 캐시 · 동시 실행 수',22,INK)
    text(d,674,476,'증설 판단',23,PURPLE,True)
    text(d,674,519,'조정 후에도 반복되면',22,INK)
    text(d,674,554,'RAM 증설을 검토하세요.',22,INK)
    shell(im,t);return im

def update(u,t):
    im=Image.new('RGB',(W,H),DARK);d=ImageDraw.Draw(im)
    badge(d,75,104,'06 / GET STARTED','#332A49','#C9B9EE',18)
    text(d,72,174,'서버마다, 한 번만.',58,'white',True)
    text(d,77,259,'기존 공용 수집기를 v1.1.8로 업데이트하세요.',25,'#B9ACCB')
    steps=[('관리자 로그인','서버 상세에서 서버 관리 열기'),('명령어 실행','기존 설치 계정의 SSH 터미널에서'),('통계 수집 시작','업데이트 이후부터 실제 기록 축적')]
    for i,(title,sub) in enumerate(steps):
        x=76+i*384;v=ease((u-.3-i*.25)/.6);y=356+(1-v)*20
        box(d,(x,y,x+360,y+225),'#2B243E',18,'#40344F')
        text(d,x+24,y+22,f'0{i+1}',23,MINT,True)
        text(d,x+24,y+80,title,28,'white',True)
        if i==1:
            text(d,x+24,y+135,'기존 설치 계정의',19,'#B9ACCB')
            text(d,x+24,y+165,'SSH 터미널에서',19,'#B9ACCB')
        else:
            text(d,x+24,y+135,sub,18,'#B9ACCB')
    text(d,78,614,'계정별 재설치 없이 · 실행 중인 실험은 그대로',20,'#B6A7C9')
    shell(im,t,True);return im

def ending(u,t):
    im=Image.new('RGB',(W,H),DARK);d=ImageDraw.Draw(im)
    badge(d,76,114,'v1.1.8 / NOW AVAILABLE','#352B4D','#C8BAED',20)
    text(d,72,204,'자원을 더 잘 알고,',63,'white',True)
    text(d,72,291,'다음 증설을 준비하다.',63,'white',True)
    text(d,77,419,'API 한도 · 자원 통계 · 병목 분석',28,'#C1B3D5')
    box(d,(77,503,1020,566),MINT,14)
    text(d,103,524,'shxyzn.github.io/gpu-timeline',29,DARK,True)
    text(d,80,603,'CVML GPU Timeline',23,'#9E8EB6',True)
    shell(im,t,True);return im

FUNCTIONS=[intro,timeline,tokens,statistics,storage,bottleneck,update,ending]
def frame(t):
    index=next((i for i,(start,end) in enumerate(SCENES) if start<=t<end),len(SCENES)-1)
    u=t-SCENES[index][0];im=FUNCTIONS[index](u,t)
    if index>0 and u<.22:
        p=ease(u/.22);prev=FUNCTIONS[index-1](SCENES[index-1][1]-SCENES[index-1][0]-.01,t)
        out=Image.new('RGB',(W,H),BG);out.paste(prev,(-int(p*W*.12),0));out.paste(im,(int((1-p)*W),0));im=out
    return im

def main():
    global REGULAR,BOLD
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--regular',required=True);parser.add_argument('--bold',required=True)
    parser.add_argument('--output',default='dist/media');parser.add_argument('--preview',action='store_true')
    args=parser.parse_args();REGULAR=args.regular;BOLD=args.bold;out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
    if args.preview:
        sheet=Image.new('RGB',(1280,720),'#E9E5F1')
        for i,t in enumerate([4,10,17,25,34,43,51,58]):
            small=frame(t).resize((426,240),Image.Resampling.LANCZOS)
            sheet.paste(small,((i%3)*426,(i//3)*240))
        sheet.save(out/'storyboard-v118.png');return
    name='CVML-GPU-Timeline-v1.1.8-60s';mp4=out/(name+'.mp4')
    command=['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-vcodec','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-an','-c:v','libx264','-preset','fast','-crf','19','-pix_fmt','yuv420p','-movflags','+faststart',str(mp4)]
    proc=subprocess.Popen(command,stdin=subprocess.PIPE)
    for i in range(FPS*DURATION):
        proc.stdin.write(frame(i/FPS).tobytes())
        if i%(FPS*5)==0:print(f'Rendered {i/FPS:.0f}s / 60s',flush=True)
    proc.stdin.close()
    if proc.wait():raise RuntimeError('Video encoding failed')
    frame(5).save(out/'poster-v1.1.8.jpg',quality=92)
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(mp4),'-filter_complex','fps=10,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3','-loop','0',str(out/(name+'.gif'))],check=True)
    print('Rendered GIF and MP4, 60 seconds.',flush=True)

if __name__=='__main__':main()
