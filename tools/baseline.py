#!/usr/bin/env python3
"""独立手算基线（纯标准库，不依赖本项目的 JS 实现）。

镜像源法在矩形房间 [0,Lx]x[0,Ly]x[0,Lz] 上有闭式结果：
  对每个面做一次镜像，路径长 = 听点到镜像点的欧氏距离；
  时间 = 距离 / 声速；幅度 = (1-alpha)/距离（球面扩散 + 单次吸收）。
运行: python3 tools/baseline.py
然后与浏览器/Node 输出的"西墙"等行对照，应在浮点精度内一致。
"""
import math

C = 343.0
# 与 index.html 默认场景一致
Lx, Ly, Lz = 6.0, 4.0, 3.0
S = (1.0, 1.0, 1.5)
R = (5.0, 3.0, 1.5)
ALPHA = 0.2
FS = 48000.0


def dist(a, b):
    return math.sqrt(sum((ai - bi) ** 2 for ai, bi in zip(a, b)))


def reflect(p, axis, value):
    """点关于平面 axis=value 的镜像（只改该坐标）。"""
    q = list(p)
    q[axis] = 2 * value - q[axis]
    return tuple(q)


def main():
    print(f"房间 {Lx}x{Ly}x{Lz} m, 声源 S={S}, 听点 R={R}, alpha={ALPHA}, c={C} m/s\n")
    d0 = dist(S, R)
    print(f"直达声 : d={d0:.4f} m  t={d0/C*1000:.4f} ms  样本 n={d0/C*FS:.3f}"
          f"  幅度 1/d={1/d0:.4f}")

    # 六个面：(名称, 镜像轴, 平面坐标)
    walls = [
        ("西墙 x=0",   0, 0.0),
        (f"东墙 x={Lx}", 0, Lx),
        ("南墙 y=0",   1, 0.0),
        (f"北墙 y={Ly}", 1, Ly),
        ("地面 z=0",   2, 0.0),
        (f"天花 z={Lz}", 2, Lz),
    ]
    print("\n一阶反射（镜像源闭式解）:")
    for name, axis, value in walls:
        img = reflect(S, axis, value)
        d = dist(img, R)
        t_ms = d / C * 1000
        n = d / C * FS
        gain = (1 - ALPHA) / d
        print(f"{name:10s} 镜像 S'={img}  d={d:.4f} m  t={t_ms:.4f} ms"
              f"  n={n:.3f} (最近 {round(n)})  幅度={gain:.4f}")

    # 西墙显式展开，供人工复核
    print("\n西墙手算展开:")
    print("  S' = (-1, 1, 1.5)")
    print(f"  d  = sqrt((5-(-1))^2 + (3-1)^2 + (1.5-1.5)^2) = sqrt(40) = {math.sqrt(40):.4f}")
    print(f"  t  = {math.sqrt(40)/C*1000:.4f} ms, 幅度 = 0.8/sqrt(40) = {0.8/math.sqrt(40):.4f}")


if __name__ == "__main__":
    main()
